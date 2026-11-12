"""Small rolling metrics sidecar for the Atlas runtime stages."""
from collections import deque
import json
import os
from pathlib import Path
import time


def write_metrics(path: Path, data: dict):
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(data), encoding="utf-8")
        for attempt in range(3):
            try:
                os.replace(temporary, path)
                return True
            except PermissionError:
                if attempt == 2:
                    return False
                time.sleep(.01 * (attempt + 1))
    except OSError:
        return False
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _summary(values):
    if not values:
        return {"average": None, "max": None, "p95": None}
    ordered = sorted(values)
    return {"average": round(sum(values) / len(values), 2), "max": round(ordered[-1], 2),
            "p95": round(ordered[max(0, (95 * len(ordered) + 99) // 100 - 1)], 2)}


class StageMetrics:
    def __init__(self, path: Path, stage: str):
        self.path, self.stage = path, stage
        self.samples = deque(maxlen=300)
        self.last_write = 0.0
        self.write_errors = 0
        self.last_write_error = None

    def record(self, duration_ms: float, monotonic: float | None = None, unix_ms: int | None = None):
        now = time.monotonic() if monotonic is None else monotonic
        self.samples.append((now, time.time_ns() // 1_000_000 if unix_ms is None else unix_ms, duration_ms))
        if now - self.last_write >= 1:
            self.write(now)

    def write(self, monotonic: float | None = None):
        now = time.monotonic() if monotonic is None else monotonic
        samples = list(self.samples)
        intervals = [(b[0] - a[0]) * 1000 for a, b in zip(samples, samples[1:])]
        span = samples[-1][0] - samples[0][0] if len(samples) > 1 else 0
        data = {
            "stage": self.stage,
            "measuredAtUnixMs": time.time_ns() // 1_000_000,
            "sampleCount": len(samples),
            "lastAtUnixMs": samples[-1][1] if samples else None,
            "fps": round((len(samples) - 1) / span, 2) if span > 0 else None,
            "intervalMs": _summary(intervals),
            "durationMs": _summary([sample[2] for sample in samples]),
            "writeErrors": self.write_errors,
            "lastWriteError": self.last_write_error,
        }
        if not write_metrics(self.path, data):
            self.write_errors += 1
            self.last_write_error = "sidecar write failed"
            data["writeErrors"] = self.write_errors
            data["lastWriteError"] = self.last_write_error
        self.last_write = now
        return data
