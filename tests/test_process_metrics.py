import unittest

from tools.process_metrics import ProcessResourceSampler


class ProcessResourceTests(unittest.TestCase):
    def test_cpu_percent_uses_cumulative_cpu_delta_and_memory_is_current(self):
        reads = iter([(2.0, 100), (2.5, 120)])
        sampler = ProcessResourceSampler(lambda _pid: next(reads), clock=iter([10.0, 11.0]).__next__)
        self.assertEqual(sampler.sample({"sender": 123})["sender"]["cpuPercent"], None)
        result = sampler.sample({"sender": 123})["sender"]
        self.assertEqual(result["cpuPercent"], 50.0)
        self.assertEqual(result["memoryBytes"], 120)

    def test_unavailable_process_is_reported_without_failing_status(self):
        sampler = ProcessResourceSampler(lambda _pid: None)
        self.assertEqual(sampler.sample({"sender": None})["sender"]["available"], False)


if __name__ == "__main__":
    unittest.main()
