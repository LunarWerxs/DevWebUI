// Windows CPU sampling with overlapping roots: a process that sits in two requested trees (an
// ancestor and one of its descendants) must contribute the same CPU to the descendant's total
// whichever root is sampled first. The old sampler re-read the shared pid in the second root with
// a zero wall-clock delta, so its CPU dropped out of that root's total and the answer depended on
// the order of the requested pids. The kernel32 here is a fake; the clock is controlled.
import { expect, spyOn, test } from "bun:test";
import {
  createWin32Buffers,
  PE32_PARENT_OFFSET,
  PE32_PID_OFFSET,
  sampleWin32Pids,
} from "../server/src/metrics";

type Fake = Parameters<typeof sampleWin32Pids>[1];

/** A fake kernel32 over a fixed process table ([pid, parent] rows) and cumulative CPU ticks. */
function fakeKernel(table: Array<[number, number]>, ticks: Map<number, number>): Fake {
  let cursor = 0;
  const writeRow = (arr: Uint8Array): number => {
    if (cursor >= table.length) return 0;
    const [pid, parent] = table[cursor];
    const dv = new DataView(arr.buffer);
    dv.setUint32(PE32_PID_OFFSET, pid, true);
    dv.setUint32(PE32_PARENT_OFFSET, parent, true);
    return 1;
  };
  const symbols = {
    CreateToolhelp32Snapshot: () => 1,
    Process32First: (_snap: number, arr: Uint8Array) => {
      cursor = 0;
      return writeRow(arr);
    },
    Process32Next: (_snap: number, arr: Uint8Array) => {
      cursor++;
      return writeRow(arr);
    },
    OpenProcess: (_access: number, _inherit: number, pid: number) => pid, // handle = pid
    CloseHandle: () => 1,
    GetProcessTimes: (h: number, _c: Uint8Array, _e: Uint8Array, kernel: Uint8Array) => {
      new DataView(kernel.buffer).setUint32(0, ticks.get(h) ?? 0, true); // user time stays 0
      return 1;
    },
    K32GetProcessMemoryInfo: () => 0, // no memory reading; CPU alone is under test
  };
  return { symbols, ptr: (x: unknown) => x } as unknown as Fake;
}

test("a process shared by an ancestor and a descendant root contributes the same CPU in either root order", async () => {
  const table: Array<[number, number]> = [
    [1, 0], // ancestor root
    [2, 1], // its child, also requested as a root
  ];
  const clock = spyOn(performance, "now");
  try {
    for (const order of [
      [1, 2],
      [2, 1],
    ]) {
      const ticks = new Map<number, number>([
        [1, 0],
        [2, 0],
      ]);
      const k = fakeKernel(table, ticks);
      const buf = createWin32Buffers();
      const last = new Map<number, { cpu100ns: number; t: number }>();
      clock.mockImplementation(() => 0);
      await sampleWin32Pids([1, 2], k, buf, last); // seed each pid's CPU history
      ticks.set(2, 5_000_000); // 500 ms of CPU over the 1000 ms between samples = 50%
      clock.mockImplementation(() => 1000);
      const out = await sampleWin32Pids(order, k, buf, last);
      expect(out[2].cpu).toBeCloseTo(50, 5);
      expect(out[1].cpu).toBeCloseTo(50, 5);
    }
  } finally {
    clock.mockRestore();
  }
});
