// X is shared by Chrome and KasmVNC. Check it before each Chrome start:
// restarting Chrome cannot repair a desktop the remote client resized.
import { execFile } from "node:child_process";

export interface XGeometry { width: number; height: number; depth: number }

export function parseXGeometry(text: string): XGeometry {
  const size = /^\s*dimensions:\s+(\d+)x(\d+)\s+pixels/m.exec(text);
  const depth = /^\s*depth of root window:\s+(\d+)\s+planes/m.exec(text);
  if (!size || !depth) throw new Error("xdpyinfo did not report the X screen's dimensions and depth");
  const geometry = { width: Number(size[1]), height: Number(size[2]), depth: Number(depth[1]) };
  if (Object.values(geometry).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("invalid X screen geometry");
  return geometry;
}

export function readXGeometry(): Promise<XGeometry> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/xdpyinfo", ["-display", ":99"], { timeout: 2000, maxBuffer: 128 * 1024, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/home/pb-operator" } }, (error, stdout) => {
      if (error) { reject(new Error("cannot read the X screen before Chrome starts")); return; }
      try { resolve(parseXGeometry(stdout)); } catch (failure) { reject(failure); }
    });
  });
}
