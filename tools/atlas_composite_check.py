#!/usr/bin/env python3
"""Inspect an A2 Atlas frame and render its Rects over a test-video pattern."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import json
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageDraw, ImageFont, ImageTk, ImageChops

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from atlas_e2e import decode_colour32_frame  # noqa: E402

OUTPUT_SIZE = (1920, 1080)
DEFAULT_URL = "rtsp://stream.usuiensan.dev:8554/bosai"


class MjpegReader:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, chunk: bytes) -> list[bytes]:
        self.buffer.extend(chunk)
        frames = []
        while True:
            start = self.buffer.find(b"\xff\xd8")
            if start < 0:
                if self.buffer[-1:] == b"\xff":
                    self.buffer[:] = b"\xff"
                else:
                    self.buffer.clear()
                return frames
            if start:
                del self.buffer[:start]
            end = self.buffer.find(b"\xff\xd9", 2)
            if end < 0:
                return frames
            frames.append(bytes(self.buffer[:end + 2]))
            del self.buffer[:end + 2]


def _put_latest(target: queue.Queue, item) -> None:
    while True:
        try:
            target.put_nowait(item)
            return
        except queue.Full:
            try:
                target.get_nowait()
            except queue.Empty:
                pass


def make_test_pattern(size=OUTPUT_SIZE) -> Image.Image:
    """Create a labelled coordinate pattern that exposes orientation and scaling errors."""
    width, height = size
    image = Image.new("RGB", size, (16, 20, 28))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=18)
    colors = ((220, 40, 40), (235, 125, 25), (220, 205, 35), (40, 165, 75),
              (35, 145, 210), (65, 80, 220), (155, 65, 200), (225, 225, 225))
    cell_w, cell_h = width // 8, height // 6
    for row in range(6):
        for column in range(8):
            x0, y0 = column * cell_w, row * cell_h
            color = colors[column] if row % 2 == 0 else tuple(channel // 2 for channel in colors[column])
            draw.rectangle((x0, y0, x0 + cell_w - 1, y0 + cell_h - 1), fill=color)
            draw.text((x0 + 5, y0 + 5), f"x={x0:04} y={y0:04}", fill="white", font=font,
                      stroke_width=1, stroke_fill="black")
    for x in range(0, width, 120):
        draw.line((x, 0, x, height), fill=(255, 255, 255), width=1)
    for y in range(0, height, 120):
        draw.line((0, y, width, y), fill=(255, 255, 255), width=1)
    draw.line((width // 2, 0, width // 2, height), fill=(0, 255, 255), width=3)
    draw.line((0, height // 2, width, height // 2), fill=(0, 255, 255), width=3)
    draw.rectangle((0, 0, 47, 47), fill=(255, 0, 255))
    draw.rectangle((width - 48, height - 48, width - 1, height - 1), fill=(0, 255, 0))
    return image


def _luminance_mask(image: Image.Image, opacity: int) -> Image.Image:
    red, green, blue = image.split()
    r = red.point([round(value * 0.2126) for value in range(256)])
    g = green.point([round(value * 0.7152) for value in range(256)])
    b = blue.point([round(value * 0.0722) for value in range(256)])
    mask = ImageChops.add(ImageChops.add(r, g), b)
    return mask.point([round(value * opacity / 255) for value in range(256)])


def render_composite(atlas: Image.Image, main_video: Image.Image, packet: dict) -> Image.Image:
    """Mirror the receiver shader's black background and ordered Rect blend."""
    if atlas.size != packet["atlas"]:
        raise ValueError("Atlas texture dimensions do not match the decoded packet")
    result = Image.new("RGB", packet["output"], "black")
    for rect in packet["rects"]:
        control, opacity = rect["control"], rect["opacity"]
        if not control & 4 or opacity == 0:
            continue
        source_image = main_video if control & 1 else atlas
        sx, sy, sw, sh = rect["src"]
        dx, dy, dw, dh = rect["dst"]
        sample = source_image.crop((sx, sy, sx + sw, sy + sh))
        if sample.size != (dw, dh):
            sample = sample.resize((dw, dh), Image.Resampling.BILINEAR)
        if control & 2:
            ax, ay, aw, ah = rect["alphaSrc"]
            alpha = source_image.crop((ax, ay, ax + aw, ay + ah))
            if alpha.size != (dw, dh):
                alpha = alpha.resize((dw, dh), Image.Resampling.BILINEAR)
            mask = _luminance_mask(alpha, opacity)
        else:
            mask = Image.new("L", (dw, dh), opacity)
        result.paste(Image.composite(sample, result.crop((dx, dy, dx + dw, dy + dh)), mask), (dx, dy))
    return result


def capture_rtsp_atlas(url: str, ffmpeg: str = "ffmpeg") -> Image.Image:
    completed = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
         "-timeout", "20000000", "-i", url, "-frames:v", "1", "-f", "image2pipe",
         "-vcodec", "png", "pipe:1"],
        check=True, capture_output=True, timeout=30,
    )
    with Image.open(BytesIO(completed.stdout)) as frame:
        return frame.convert("RGB")


def decode_atlas(atlas: Image.Image) -> tuple[bytes, dict]:
    return decode_colour32_frame(atlas.convert("RGB").tobytes(), atlas.size)


def write_unity_bundle(target: Path, atlas: Image.Image, pattern: Image.Image, rendered: Image.Image,
                       packet_bytes: bytes, packet: dict) -> None:
    rects = [{"control": rect["control"], "opacity": rect["opacity"], "src": rect["src"],
              "dst": rect["dst"], "alphaSrc": rect["alphaSrc"]} for rect in packet["rects"]]
    manifest = {"atlasSize": packet["atlas"], "mainVideoSize": pattern.size,
                "outputSize": packet["output"], "sequence": packet["sequence"],
                "crc32": packet_bytes[-4:].hex(), "packetHex": packet_bytes.hex(), "rects": rects}
    atlas.save(target / "atlas.png")
    pattern.save(target / "main-video-test-pattern.png")
    rendered.save(target / "reference.png")
    (target / "rects.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class AtlasCompositeApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Atlas II 合成確認")
        self.root.geometry("1120x780")
        self.atlas = None
        self.rendered = None
        self.preview = None
        self.packet = None
        self.packet_bytes = None
        self.udon = None
        self.diff = None
        self.url = tk.StringVar(value=DEFAULT_URL)
        self.continuous = False
        self._stream_process = None
        self._stream_thread = None
        self._stream_stop = None
        self._stream_frames = None
        self._poll_job = None
        bar = ttk.Frame(root, padding=10)
        bar.pack(fill="x")
        connection = ttk.Frame(bar)
        connection.pack(fill="x")
        actions = ttk.Frame(bar)
        actions.pack(fill="x", pady=(5, 0))
        ttk.Label(connection, text="RTSP URL").pack(side="left")
        ttk.Entry(connection, textvariable=self.url, width=64).pack(side="left", padx=6)
        ttk.Button(connection, text="1フレーム取得", command=self.load_rtsp).pack(side="left", padx=3)
        self.continuous_button = ttk.Button(connection, text="連続表示を開始", command=self.toggle_continuous)
        self.continuous_button.pack(side="left", padx=3)
        ttk.Button(actions, text="Atlas画像を開く", command=self.load_file).pack(side="left", padx=3)
        ttk.Button(actions, text="合成PNGを保存", command=self.save_result).pack(side="left", padx=3)
        ttk.Button(actions, text="テストパターンを保存", command=self.save_pattern).pack(side="left", padx=3)
        ttk.Button(actions, text="Unity比較用を保存", command=self.save_unity_bundle).pack(side="left", padx=3)
        ttk.Button(actions, text="Udon合成PNGと比較", command=self.compare_udon).pack(side="left", padx=3)
        self.status = ttk.Label(root, text="RTSP取得かAtlas画像を開いてください", padding=(10, 0, 10, 8))
        self.status.pack(anchor="w")
        viewer = ttk.Frame(root, padding=(10, 4))
        viewer.pack(fill="both", expand=True)
        left, right = ttk.Frame(viewer), ttk.Frame(viewer)
        left.pack(side="left", fill="both", expand=True, padx=(0, 5))
        right.pack(side="left", fill="both", expand=True, padx=(5, 0))
        ttk.Label(left, text="入力 Atlas").pack(anchor="w")
        ttk.Label(right, text="参照合成 1920×1080").pack(anchor="w")
        self.atlas_label = ttk.Label(left, anchor="center")
        self.atlas_label.pack(fill="both", expand=True)
        self.image_label = ttk.Label(right, anchor="center")
        self.image_label.pack(fill="both", expand=True)
        self.details = tk.Text(root, height=8, wrap="none", font=("Consolas", 10))
        self.details.pack(fill="x", padx=10, pady=(4, 10))
        self.details.insert("end", "出力サイズ: 1920×1080\n背景: 黒。MAIN_VIDEO Rectは座標テストパターンを使用\n")
        self.details.configure(state="disabled")
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def toggle_continuous(self):
        if self.continuous:
            self._stop_continuous("連続表示を停止しました。最後の有効な合成結果を表示中")
            return
        if self._stream_thread and self._stream_thread.is_alive():
            self.status.configure(text="前のRTSP接続を停止中です。少し待ってから再開してください")
            return
        url = self.url.get().strip()
        if not url:
            messagebox.showinfo("RTSP URLなし", "連続取得するRTSP URLを入力してください")
            return
        self.continuous = True
        self._stream_stop = threading.Event()
        self._stream_frames = queue.Queue(maxsize=1)
        self.continuous_button.configure(text="連続表示を停止")
        self.status.configure(text="RTSPへ接続中…最後の有効な合成結果をウィンドウに保持します")
        self._stream_thread = threading.Thread(target=self._read_stream,
                                               args=(url, self._stream_stop, self._stream_frames), daemon=True)
        self._stream_thread.start()
        self._poll_stream()

    def _read_stream(self, url: str, stop_event: threading.Event, frame_queue: queue.Queue):
        while not stop_event.is_set():
            process = None
            try:
                process = subprocess.Popen(
                    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
                     "-timeout", "30000000", "-i", url, "-vf", "fps=2", "-an", "-sn", "-dn",
                     "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                )
                self._stream_process = process
                reader = MjpegReader()
                while not stop_event.is_set():
                    chunk = process.stdout.read(4096)
                    if not chunk:
                        break
                    for frame in reader.feed(chunk):
                        with Image.open(BytesIO(frame)) as image:
                            _put_latest(frame_queue, ("frame", image.convert("RGB")))
            except Exception:
                pass
            finally:
                if process is not None:
                    if process.poll() is None:
                        process.terminate()
                    if process.stdout:
                        process.stdout.close()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                if self._stream_process is process:
                    self._stream_process = None
            if not stop_event.is_set():
                _put_latest(frame_queue, ("status", "RTSP切断。5秒後に再接続します。最後の有効結果を保持中"))
                stop_event.wait(5)

    def _poll_stream(self):
        if not self.continuous:
            return
        latest = None
        try:
            while True:
                latest = self._stream_frames.get_nowait()
        except queue.Empty:
            pass
        if latest:
            kind, value = latest
            if kind == "status":
                self.status.configure(text=value)
                self._poll_job = self.root.after(100, self._poll_stream)
                return
            try:
                self._process(value)
                status = self.status.cget("text")
                prefix = "連続表示中 | "
                if not status.startswith(prefix):
                    status = prefix + status
                self.status.configure(text=status)
            except Exception as error:
                self.status.configure(text=f"A2フレームを拒否しました。前回の有効結果を保持中: {error}")
        self._poll_job = self.root.after(100, self._poll_stream)

    def _stop_continuous(self, status: str):
        self.continuous = False
        if self._stream_stop:
            self._stream_stop.set()
        if self._stream_process and self._stream_process.poll() is None:
            self._stream_process.terminate()
        if self._poll_job:
            self.root.after_cancel(self._poll_job)
            self._poll_job = None
        if self._stream_thread and self._stream_thread.is_alive():
            self._stream_thread.join(timeout=1)
        self.continuous_button.configure(text="連続表示を開始")
        self.status.configure(text=status)

    def close(self):
        self._stop_continuous("終了中")
        if self._stream_thread and self._stream_thread.is_alive():
            self._stream_thread.join(timeout=2)
        self.root.destroy()

    def load_rtsp(self):
        try:
            self._process(capture_rtsp_atlas(self.url.get().strip()))
        except Exception as error:
            messagebox.showerror("RTSP取得失敗", str(error))

    def load_file(self):
        path = filedialog.askopenfilename(filetypes=[("画像", "*.png *.jpg *.jpeg *.bmp *.webp"), ("すべて", "*.*")])
        if path:
            try:
                with Image.open(path) as image:
                    self._process(image.convert("RGB"))
            except Exception as error:
                messagebox.showerror("Atlas読込失敗", str(error))

    def _process(self, atlas: Image.Image):
        packet_bytes, packet = decode_atlas(atlas)
        if packet["output"] != OUTPUT_SIZE:
            raise ValueError(f"1920×1080 output expected, packet says {packet['output'][0]}×{packet['output'][1]}")
        rendered = render_composite(atlas, make_test_pattern(), packet)
        self.atlas, self.rendered, self.packet, self.packet_bytes = atlas.copy(), rendered, packet, packet_bytes
        preview = rendered.copy()
        preview.thumbnail((1080, 610), Image.Resampling.LANCZOS)
        self.preview = ImageTk.PhotoImage(preview)
        atlas_preview = atlas.copy()
        atlas_preview.thumbnail((520, 315), Image.Resampling.LANCZOS)
        self.atlas_preview = ImageTk.PhotoImage(atlas_preview)
        self.atlas_label.configure(image=self.atlas_preview)
        self.image_label.configure(image=self.preview)
        rect_rows = []
        for index, rect in enumerate(packet["rects"]):
            ctl = rect["control"]
            rect_rows.append(f"{index:02}: {'MAIN_VIDEO' if ctl & 1 else 'ATLAS':10} "
                             f"{'ALPHA_PAIR' if ctl & 2 else 'COPY':10} visible={bool(ctl & 4)} "
                             f"opacity={rect['opacity']:3} src={rect['src']} dst={rect['dst']} alpha={rect['alphaSrc']}")
        self.details.configure(state="normal")
        self.details.delete("1.0", "end")
        self.details.insert("end", "\n".join(rect_rows) or "Rectなし（参照合成は黒）")
        self.details.configure(state="disabled")
        crc = packet_bytes[-4:].hex()
        self.status.configure(text=f"A2 v2 OK | {atlas.width}×{atlas.height} | sequence {packet['sequence']} | "
                                   f"{len(packet['rects'])} Rect | CRC {crc}")

    def save_result(self):
        if self.rendered is None:
            messagebox.showinfo("未合成", "先にAtlasを読み込んでください")
            return
        path = filedialog.asksaveasfilename(defaultextension=".png", initialfile="atlas-reference-composite.png",
                                            filetypes=[("PNG", "*.png")])
        if path:
            self.rendered.save(path)
            self.status.configure(text=f"保存しました: {path}")

    def save_pattern(self):
        path = filedialog.asksaveasfilename(defaultextension=".png", initialfile="atlas-main-test-pattern.png",
                                            filetypes=[("PNG", "*.png")])
        if path:
            make_test_pattern().save(path)
            self.status.configure(text=f"テストパターンを保存しました: {path}")

    def save_unity_bundle(self):
        if self.atlas is None or self.packet is None:
            messagebox.showinfo("入力なし", "先にRTSPかAtlas画像を読み込んでください")
            return
        folder = filedialog.askdirectory(title="Unity比較用フォルダーを選択")
        if not folder:
            return
        target = Path(folder)
        names = ("atlas.png", "main-video-test-pattern.png", "rects.json", "reference.png")
        if any((target / name).exists() for name in names):
            if not messagebox.askyesno("上書き確認", "同名の比較ファイルを上書きしますか？"):
                return
        write_unity_bundle(target, self.atlas, make_test_pattern(), self.rendered, self.packet_bytes, self.packet)
        self.status.configure(text=f"Unity比較用ファイルを保存しました: {target}")

    def compare_udon(self):
        if self.rendered is None:
            messagebox.showinfo("参照合成なし", "先にRTSPかAtlas画像を読み込んでください")
            return
        path = filedialog.askopenfilename(filetypes=[("PNG", "*.png"), ("すべて", "*.*")])
        if not path:
            return
        try:
            with Image.open(path) as image:
                udon = image.convert("RGB")
            if udon.size != OUTPUT_SIZE:
                raise ValueError(f"Udon画像は1920×1080が必要です（取得値 {udon.width}×{udon.height}）")
            difference = ImageChops.difference(self.rendered, udon)
            histogram = difference.histogram()
            changed_channels = sum(histogram[channel * 256 + value]
                                   for channel in range(3) for value in range(1, 256))
            mean_error = sum(value * histogram[channel * 256 + value]
                             for channel in range(3) for value in range(256)) / (OUTPUT_SIZE[0] * OUTPUT_SIZE[1] * 3)
            self.udon = udon
            self.diff = difference.point([min(255, value * 4) for value in range(256)])
            self.status.configure(text=f"Udon比較: 変更チャンネル {changed_channels:,} | "
                                       f"平均絶対差 {mean_error:.2f}/255 | 差分表示は4倍")
            window = tk.Toplevel(self.root)
            window.title("参照合成とUdon出力の差分")
            for column, (label, source) in enumerate((("Udon出力", udon), ("差分（4倍表示）", self.diff))):
                frame = ttk.Frame(window, padding=8)
                frame.grid(row=0, column=column, sticky="nsew")
                ttk.Label(frame, text=label).pack(anchor="w")
                preview = source.copy()
                preview.thumbnail((640, 360), Image.Resampling.LANCZOS)
                photo = ImageTk.PhotoImage(preview)
                display = ttk.Label(frame, image=photo)
                display.image = photo
                display.pack()
                if column == 0:
                    self.udon_preview = photo
                else:
                    self.diff_preview = photo
            ttk.Label(window, text=f"変更チャンネル {changed_channels:,} / {OUTPUT_SIZE[0] * OUTPUT_SIZE[1] * 3:,}　"
                                   f"平均絶対差 {mean_error:.2f}/255").grid(row=1, column=0, columnspan=2, pady=6)
            ttk.Button(window, text="差分PNGを保存", command=self.save_diff).grid(row=2, column=0, columnspan=2, pady=6)
        except Exception as error:
            messagebox.showerror("Udon比較失敗", str(error))

    def save_diff(self):
        if self.diff is None:
            return
        path = filedialog.asksaveasfilename(defaultextension=".png", initialfile="udon-composite-diff.png",
                                            filetypes=[("PNG", "*.png")])
        if path:
            self.diff.save(path)
            self.status.configure(text=f"差分画像を保存しました: {path}")


def main():
    root = tk.Tk()
    AtlasCompositeApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
