import json
import tempfile
import unittest
from pathlib import Path

import pier_pi_agent
from pier_pi_agent import collect_pi_session_metrics


class PiAgentPackagingTest(unittest.TestCase):
    def _agent(self, root: Path, **kwargs: object) -> pier_pi_agent.PiCodingAgent:
        agent_dir = root / "agent"
        agent_dir.mkdir()
        (agent_dir / "auth.json").write_text("{}")
        return pier_pi_agent.PiCodingAgent(
            logs_dir=root / "logs",
            model_name="openai-codex/gpt-5.6-sol",
            pi_agent_dir=str(agent_dir),
            **kwargs,
        )

    def test_uses_selected_fabric_global_extension_path(self) -> None:
        self.assertEqual(
            pier_pi_agent.fabric_extension_flags("ultra-fabric"),
            '-e "$(npm root -g)/ultra-fabric"',
        )
        self.assertEqual(
            pier_pi_agent.fabric_extension_flags("pi-fabric"),
            '-e "$(npm root -g)/pi-fabric"',
        )

    def test_extracts_package_name_from_exact_npm_spec(self) -> None:
        self.assertEqual(
            pier_pi_agent.package_name_from_spec("pi-fabric@0.25.6"),
            "pi-fabric",
        )
        self.assertEqual(
            pier_pi_agent.package_name_from_spec(
                "ultra-fabric@0.31.1-ultra.1"
            ),
            "ultra-fabric",
        )

    def test_rejects_unsafe_or_non_exact_npm_specs(self) -> None:
        for spec in (
            "pi-fabric",
            "pi-fabric@latest",
            "pi-fabric@^0.25.6",
            "pi-fabric@0.25.6; touch /tmp/unsafe",
        ):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                pier_pi_agent.package_name_from_spec(spec)

    def test_installs_exact_npm_package_in_cached_agent_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = self._agent(
                Path(directory), fabric_package_spec="pi-fabric@0.25.6"
            )
            command = agent.install_spec().steps[0].run

        self.assertIn("--legacy-peer-deps", command)
        self.assertIn("pi-fabric@0.25.6", command)

    def test_rejects_package_path_and_spec_together(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "fabric.tgz"
            archive.write_bytes(b"archive")
            with self.assertRaises(ValueError):
                self._agent(
                    root,
                    fabric_package_path=str(archive),
                    fabric_package_name="ultra-fabric",
                    fabric_package_spec="ultra-fabric@0.31.1-ultra.1",
                )


class PiSessionMetricsTest(unittest.TestCase):
    def test_collects_pareto_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session = Path(directory) / "session.jsonl"
            records = [
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 100,
                            "cacheWrite": 5,
                            "cacheRead": 200,
                            "output": 20,
                            "totalTokens": 325,
                            "cost": {"total": 0.25},
                        },
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "read",
                                "arguments": {"path": "README.md"},
                            }
                        ],
                    },
                },
                {
                    "type": "message",
                    "message": {
                        "role": "toolResult",
                        "toolName": "fabric_exec",
                        "content": [{"type": "text", "text": "x" * 50_001}],
                        "details": {
                            "trace": {
                                "outcome": "failed",
                                "operations": [
                                    {
                                        "ref": "pi.read",
                                        "args": {
                                            "path": "src/a.ts",
                                            "offset": 10,
                                            "limit": 20,
                                        },
                                    },
                                    {
                                        "ref": "pi.edit",
                                        "args": {"path": "src/a.ts"},
                                    },
                                    {
                                        "ref": "pi.edit",
                                        "args": {"path": "src/a.ts"},
                                    },
                                ]
                            }
                        },
                    },
                },
                {"type": "compaction"},
            ]
            session.write_text("".join(json.dumps(row) + "\n" for row in records))

            metrics = collect_pi_session_metrics(Path(directory))

        self.assertEqual(metrics["input_tokens"], 305)
        self.assertEqual(metrics["fresh_input_tokens"], 105)
        self.assertEqual(metrics["cache_tokens"], 200)
        self.assertEqual(metrics["output_tokens"], 20)
        self.assertEqual(metrics["combined_total_tokens"], 325)
        self.assertEqual(metrics["peak_context_tokens"], 305)
        self.assertEqual(metrics["outer_tool_calls"], 1)
        self.assertEqual(metrics["outer_calls_by_name"], {"read": 1})
        self.assertEqual(metrics["nested_tool_calls"], 3)
        self.assertEqual(metrics["nested_calls_by_ref"], {
            "pi.edit": 2,
            "pi.read": 1,
        })
        self.assertEqual(metrics["fabric_failures"], 1)
        self.assertEqual(metrics["same_file_extra_edits"], 1)
        self.assertEqual(metrics["model_visible_result_chars"], 50_001)
        self.assertEqual(metrics["max_result_chars"], 50_001)
        self.assertEqual(metrics["whole_file_reads"], 1)
        self.assertEqual(metrics["bounded_reads"], 1)
        self.assertEqual(metrics["results_over_50kb"], 1)
        self.assertEqual(metrics["summarization_count"], 1)


if __name__ == "__main__":
    unittest.main()
