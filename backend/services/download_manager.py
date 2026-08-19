import asyncio
import os
import uuid
import shutil
from typing import Tuple

import yt_dlp

DOWNLOADS_ROOT = os.path.join(os.path.dirname(__file__), "..", "downloads")
os.makedirs(DOWNLOADS_ROOT, exist_ok=True)

# Limit concurrent downloads
_download_semaphore = asyncio.Semaphore(2)


class DownloadError(Exception):
    pass


async def download_video(url: str, max_filesize: int = 100 * 1024 * 1024) -> Tuple[str, str]:
    """Download a video using yt-dlp into a unique subdirectory.

    Returns (download_id, filename)
    Raises DownloadError on failure.
    """
    async with _download_semaphore:
        download_id = uuid.uuid4().hex
        out_dir = os.path.join(DOWNLOADS_ROOT, download_id)
        os.makedirs(out_dir, exist_ok=True)

        ydl_opts = {
            "extractor_args": {"youtube": {"player_client": ["android"]}},
            # Prefer mp4 up to 720p; fall back to best available
            "format": "18/best[height<=720][ext=mp4]/best",
            # Use id-based template to avoid unsafe titles in filenames
            "outtmpl": os.path.join(out_dir, "%(id)s.%(ext)s"),
            "merge_output_format": "mp4",
            "noplaylist": True,
            "max_filesize": max_filesize,
            "quiet": True,
            "no_warnings": True,
        }

        def _run_download():
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    return info
            except Exception as exc:
                # cleanup partial dir
                try:
                    shutil.rmtree(out_dir)
                except Exception:
                    pass
                raise

        try:
            info = await asyncio.to_thread(_run_download)
        except Exception as exc:
            raise DownloadError(f"yt-dlp failed: {exc}") from exc

        # locate the downloaded file
        files = [f for f in os.listdir(out_dir) if os.path.isfile(os.path.join(out_dir, f))]
        if not files:
            shutil.rmtree(out_dir, ignore_errors=True)
            raise DownloadError("No file found after download")

        # pick the largest file (in case of thumbnail or multiple files)
        files_with_size = [(f, os.path.getsize(os.path.join(out_dir, f))) for f in files]
        files_with_size.sort(key=lambda t: t[1], reverse=True)
        filename = files_with_size[0][0]
        filepath = os.path.join(out_dir, filename)

        # final size check
        final_size = os.path.getsize(filepath)
        if final_size > max_filesize:
            # cleanup
            try:
                shutil.rmtree(out_dir)
            except Exception:
                pass
            raise DownloadError("Downloaded file exceeds size limit")

        return download_id, filename
