"""Per-process CPU and resident-memory samples without third-party dependencies."""
import os
import time


def read_process_usage(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class FileTime(ctypes.Structure):
            _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

        class MemoryCounters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("pageFaultCount", wintypes.DWORD),
                        ("peakWorkingSetSize", ctypes.c_size_t), ("workingSetSize", ctypes.c_size_t),
                        ("peakPagedPoolUsage", ctypes.c_size_t), ("pagedPoolUsage", ctypes.c_size_t),
                        ("peakNonPagedPoolUsage", ctypes.c_size_t), ("nonPagedPoolUsage", ctypes.c_size_t),
                        ("pagefileUsage", ctypes.c_size_t), ("peakPagefileUsage", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileTime), ctypes.POINTER(FileTime),
                                           ctypes.POINTER(FileTime), ctypes.POINTER(FileTime)]
        kernel.GetProcessTimes.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x0400 | 0x0010, False, pid)
        if not handle:
            return None
        try:
            creation, exit_time, kernel_time, user_time = FileTime(), FileTime(), FileTime(), FileTime()
            memory = MemoryCounters(); memory.cb = ctypes.sizeof(memory)
            if not kernel.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time),
                                          ctypes.byref(kernel_time), ctypes.byref(user_time)):
                return None
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                return None
            ticks = lambda ft: (ft.high << 32) | ft.low
            return ((ticks(kernel_time) + ticks(user_time)) / 10_000_000, memory.workingSetSize)
        finally:
            kernel.CloseHandle(handle)

    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as stat_file:
            fields = stat_file.read().rsplit(")", 1)[1].split()
        cpu_seconds = (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")
        with open(f"/proc/{pid}/statm", encoding="ascii") as memory_file:
            resident_pages = int(memory_file.read().split()[1])
        return cpu_seconds, resident_pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return None


class ProcessResourceSampler:
    def __init__(self, reader=read_process_usage, clock=time.monotonic):
        self.reader, self.clock, self.previous = reader, clock, {}

    def sample(self, processes):
        now, result = self.clock(), {}
        active = {pid for pid in processes.values() if pid}
        self.previous = {pid: value for pid, value in self.previous.items() if pid in active}
        for name, pid in processes.items():
            usage = self.reader(pid) if pid else None
            if usage is None:
                result[name] = {"available": False, "pid": pid}
                continue
            cpu_seconds, memory_bytes = usage
            previous = self.previous.get(pid)
            cpu_percent = max(0.0, (cpu_seconds - previous[0]) * 100 / (now - previous[1])) if previous and now > previous[1] else None
            self.previous[pid] = (cpu_seconds, now)
            result[name] = {"available": True, "pid": pid, "cpuPercent": round(cpu_percent, 1) if cpu_percent is not None else None,
                            "memoryBytes": memory_bytes}
        return result
