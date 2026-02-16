#!/usr/bin/env python3
"""
YaneuraOu + Hao 用 解析サーバ (秒数指定 / 4 インスタンス / カレントディレクトリ版)

- このプロジェクトのディレクトリ直下に engine/ ディレクトリを作り、
  その中に YaneuraOu バイナリと eval/nn.bin (Hao) を置く前提。
- FastAPI + uvicorn で HTTP API (/analyze) を公開。
- プロセス内で 4 個のエンジンインスタンスをプールして、キュー形式で解析をさばく。
- クライアントからは think_seconds（秒）で解析時間を指定 (デフォルト 1 秒)。
"""

import os
import sys
import subprocess
import threading
import queue
from collections import deque
from typing import List, Dict, Optional, Any
import select
import time
import ipaddress

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ===== 設定値 =====

# 設定は環境変数で上書きできます（未設定なら従来のデフォルト）。
def _env_int(name: str, default: int) -> int:
    try:
        v = os.getenv(name)
        return int(v) if v is not None else default
    except Exception:
        return default

# このファイルのあるディレクトリを基準に engine/ を探す（YANEO_SERVER_BASE_DIR で上書き可）
BASE_DIR = os.getenv("YANEO_SERVER_BASE_DIR") or os.path.dirname(os.path.abspath(__file__))

def _resolve_under_base(path: str) -> str:
    """相対パスは BASE_DIR 基準で解決する（systemd 等で cwd が変わっても壊れないように）。"""
    if not path:
        return path
    if os.path.isabs(path):
        return path
    return os.path.join(BASE_DIR, path)

# エンジン本体
_engine_bin = os.getenv("YANEO_ENGINE_BIN", "YaneuraOu-by-gcc")
_engine_dir_env = os.getenv("YANEO_ENGINE_DIR")
ENGINE_DIR = _resolve_under_base(_engine_dir_env) if _engine_dir_env else os.path.join(BASE_DIR, "engine")

_engine_path_env = os.getenv("YANEO_ENGINE_PATH")
if _engine_path_env:
    ENGINE_PATH = _resolve_under_base(_engine_path_env)
    # YANEO_ENGINE_PATH がディレクトリなら、その配下の実行ファイルを探す
    if os.path.isdir(ENGINE_PATH):
        ENGINE_PATH = os.path.join(ENGINE_PATH, _engine_bin)
else:
    ENGINE_PATH = os.path.join(ENGINE_DIR, _engine_bin)

# 評価関数ディレクトリ（ENGINE_DIR からの相対が基本。絶対パスも可）
EVAL_DIR = os.getenv("YANEO_EVAL_DIR") or "eval"

def _nn_bin_path() -> str:
    if os.path.isabs(EVAL_DIR):
        return os.path.join(EVAL_DIR, "nn.bin")
    return os.path.join(ENGINE_DIR, EVAL_DIR, "nn.bin")

# 起動時に最低限の存在チェック（ここで落ちれば autostart 側のログに出る）
if not os.path.isfile(ENGINE_PATH):
    raise RuntimeError(
        f"Engine binary not found: {ENGINE_PATH}. "
        f"Place it at '<project_root>/engine/{_engine_bin}' or set YANEO_ENGINE_PATH/YANEO_ENGINE_DIR."
    )
if not os.path.isfile(_nn_bin_path()):
    raise RuntimeError(
        f"NNUE file not found: {_nn_bin_path()}. "
        f"Place it at '<project_root>/engine/{EVAL_DIR}/nn.bin' or set YANEO_EVAL_DIR."
    )

print(f"[engine_server] BASE_DIR={BASE_DIR}", file=sys.stderr, flush=True)
print(f"[engine_server] ENGINE_DIR={ENGINE_DIR}", file=sys.stderr, flush=True)
print(f"[engine_server] ENGINE_PATH={ENGINE_PATH}", file=sys.stderr, flush=True)
print(f"[engine_server] EVAL_DIR={EVAL_DIR}", file=sys.stderr, flush=True)

# 1 インスタンスあたりの設定
ENGINE_THREADS = _env_int("YANEO_ENGINE_THREADS", 1)      # 1 コア専有前提
ENGINE_HASH_MB = _env_int("YANEO_ENGINE_HASH_MB", 1024)   # ハッシュ 1GB 相当 (環境に応じて調整可)
FV_SCALE = _env_int("YANEO_FV_SCALE", 20)                 # Hao 推奨値

# プロセス内で何インスタンス回すか
ENGINE_INSTANCES = _env_int("YANEO_ENGINE_INSTANCES", 4)  # 4 並列まで解析を許可



class YaneuraOuEngine:
    """
    1 プロセスのやねうら王と USI でやり取りするラッパ。
    analyze() 呼び出し単位で排他制御する。
    """

    def __init__(
        self,
        engine_path: str,
        workdir: str,
        eval_dir: str = "eval",
        threads: int = 1,
        hash_mb: int = 1024,
        fv_scale: Optional[int] = None,
    ) -> None:
        if not os.path.isfile(engine_path):
            raise FileNotFoundError(f"Engine not found: {engine_path}")

        self.engine_path = engine_path
        self.workdir = workdir
        self.eval_dir = eval_dir
        self.threads = threads
        self.hash_mb = hash_mb
        self.fv_scale = fv_scale

        self.proc = subprocess.Popen(
            [self.engine_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=self.workdir,
        )

        if self.proc.stdin is None or self.proc.stdout is None or self.proc.stderr is None:
            raise RuntimeError("Failed to open stdin/stdout/stderr of engine process")

        self.lock = threading.Lock()

        # --- stderr reader (prevent pipe from filling; keep tail for debugging) ---
        self._stderr_tail = deque(maxlen=200)
        self._stderr_lock = threading.Lock()
        self._stderr_thread = threading.Thread(
            target=self._stderr_reader,
            name=f"engine-stderr-{self.proc.pid}",
            daemon=True,
        )
        self._stderr_thread.start()

        self.option_names: set[str] = set()
        self.verify_position: bool = os.getenv("ENGINE_VERIFY_POSITION", "0").lower() in ("1","true","yes","y")
        self._last_multipv: Optional[int] = None
        self._init_usi()

    # --- 内部 I/O ヘルパー ---

    def _send(self, cmd: str) -> None:
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _stderr_reader(self) -> None:
        """Continuously drain engine stderr to server stderr (and keep a small tail)."""
        if self.proc.stderr is None:
            return
        try:
            for line in self.proc.stderr:
                s = line.rstrip("\n")
                with self._stderr_lock:
                    self._stderr_tail.append(s)
                # Mirror to server stderr for diagnostics.
                print(f"[engine stderr pid={self.proc.pid}] {s}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[engine stderr pid={self.proc.pid}] (stderr reader stopped: {e})", file=sys.stderr, flush=True)

    def _read_line(self) -> str:
        line = self.proc.stdout.readline()
        if not line:
            return ""
        return line.rstrip("\n")


    def _drain_available(self, limit: int = 2000) -> List[str]:
        """stdout に残っている行をブロックせずに読み捨てる。"""
        out: List[str] = []
        if self.proc.stdout is None:
            return out
        fd = self.proc.stdout.fileno()
        while limit > 0:
            r, _, _ = select.select([fd], [], [], 0)
            if not r:
                break
            line = self.proc.stdout.readline()
            if not line:
                break
            out.append(line.rstrip("\n"))
            limit -= 1
        return out

    
    def _extract_option_names(self, lines: List[str]) -> set[str]:
        names: set[str] = set()
        for line in lines:
            if line.startswith("option name "):
                rest = line[len("option name "):]
                # USI: "option name <name> type <type> ..."
                name = rest.split(" type ", 1)[0].strip()
                if name:
                    names.add(name)
        return names

    def _read_line_timeout(self, timeout_ms: int) -> Optional[str]:
        """Read one line from engine stdout with a timeout. Returns None on timeout."""
        try:
            rlist, _, _ = select.select([self.proc.stdout], [], [], timeout_ms / 1000.0)
        except Exception:
            return None
        if not rlist:
            return None
        return self._read_line()

    def _drain_capture(
        self, max_total_ms: int = 150, idle_quiet_ms: int = 80, max_lines: int = 5000
    ) -> List[str]:
        """Drain any pending stdout lines (best-effort). Returns drained lines."""
        drained: List[str] = []
        start = time.time()
        last_got = time.time()
        while len(drained) < max_lines:
            remaining = max_total_ms / 1000.0 - (time.time() - start)
            if remaining <= 0:
                break
            line = self._read_line_timeout(int(min(50, remaining * 1000)))
            if line is None:
                if (time.time() - last_got) * 1000.0 >= idle_quiet_ms:
                    break
                continue
            drained.append(line)
            last_got = time.time()
        return drained

    def _read_until_one_of(self, values: set[str], timeout_ms: int = 300) -> Optional[str]:
        deadline = time.time() + timeout_ms / 1000.0
        while time.time() < deadline:
            line = self._read_line_timeout(50)
            if line is None:
                continue
            if line in values:
                return line
        return None

    def _read_sfen_from_d(self, timeout_ms: int = 600) -> Optional[str]:
        """Send after 'd' and parse the trailing 'sfen ...' line (YaneuraOu extension)."""
        deadline = time.time() + timeout_ms / 1000.0
        sfen_line: Optional[str] = None
        while time.time() < deadline:
            line = self._read_line_timeout(50)
            if line is None:
                continue
            if line.startswith("sfen "):
                sfen_line = line[len("sfen "):].strip()
                break
        return sfen_line

    def _drain_until_quiet(self, max_total_ms: int = 200, quiet_ms: int = 20, limit: int = 5000) -> List[str]:
        """一定時間 stdout が静かになるまで読み捨てる（stop 後の残り出力対策）。"""
        out: List[str] = []
        if self.proc.stdout is None:
            return out
        fd = self.proc.stdout.fileno()
        end = time.monotonic() + (max_total_ms / 1000.0)
        while time.monotonic() < end and limit > 0:
            timeout = min(quiet_ms / 1000.0, max(0.0, end - time.monotonic()))
            r, _, _ = select.select([fd], [], [], timeout)
            if not r:
                break  # quiet
            line = self.proc.stdout.readline()
            if not line:
                break
            out.append(line.rstrip("\n"))
            limit -= 1
        if limit > 0:
            out.extend(self._drain_available(limit=limit))
        return out

    def _read_until_prefix(self, prefix: str) -> List[str]:
        lines: List[str] = []
        while True:
            line = self._read_line()
            if not line:
                continue
            lines.append(line)
            if line.startswith(prefix):
                break
        return lines

    def _init_usi(self) -> None:
        self._send("usi")
        usi_lines = self._read_until_prefix("usiok")
        self.option_names = self._extract_option_names(usi_lines)

        if self.eval_dir:
            self._send(f"setoption name EvalDir value {self.eval_dir}")

        self._send(f"setoption name USI_Hash value {self.hash_mb}")
        self._send(f"setoption name Threads value {self.threads}")

        if self.fv_scale is not None:
            self._send(f"setoption name FV_SCALE value {self.fv_scale}")

        # Avoid noisy / missing opening-book reads if supported by the engine (YaneuraOu uses BookFile).
        if "BookFile" in self.option_names:
            # YaneuraOu: "no_book" disables book usage.
            self._send("setoption name BookFile value no_book")
        if "USI_OwnBook" in self.option_names:
            self._send("setoption name USI_OwnBook value false")
        if "OwnBook" in self.option_names:
            self._send("setoption name OwnBook value false")

        self._send("isready")
        self._read_until_prefix("readyok")


    @staticmethod
    def _is_startpos_sfen(sfen: str) -> bool:
        """平手初期局面なら True。move number や手番は無視して判定する。"""
        try:
            parts = sfen.strip().split()
            if not parts:
                return False
            board = parts[0]
            hands = parts[2] if len(parts) >= 3 else None
            return board == "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL" and hands == "-"
        except Exception:
            return False

    @classmethod
    def _build_position_cmd(cls, sfen: str, moves: List[str]) -> str:
        # Always use explicit SFEN to avoid engine-specific 'startpos' handling.
        base = f"position sfen {sfen}"
        if moves:
            return base + " moves " + " ".join(moves)
        return base

    @staticmethod
    def _parse_info_line(line: str) -> Optional[Dict[str, Any]]:
        if not line.startswith("info"):
            return None

        tokens = line.split()
        multipv = 1
        score_cp: Optional[int] = None
        score_mate: Optional[int] = None
        pv_moves: List[str] = Field(default_factory=list)

        i = 1
        pv_start = None
        while i < len(tokens):
            t = tokens[i]
            if t == "multipv" and i + 1 < len(tokens):
                try:
                    multipv = int(tokens[i + 1])
                except ValueError:
                    pass
                i += 2
            elif t == "score" and i + 2 < len(tokens):
                stype = tokens[i + 1]
                sval = tokens[i + 2]
                try:
                    if stype == "cp":
                        score_cp = int(sval)
                    elif stype == "mate":
                        score_mate = int(sval)
                except ValueError:
                    pass
                i += 3
            elif t == "pv":
                pv_start = i + 1
                break
            else:
                i += 1

        if pv_start is not None and pv_start < len(tokens):
            pv_moves = tokens[pv_start:]

        return {
            "multipv": multipv,
            "score_cp": score_cp,
            "score_mate": score_mate,
            "pv": pv_moves,
            "raw": line,
        }

    def analyze(
        self,
        sfen: str,
        moves: List[str],
        byoyomi: int = 1000,
        multipv: int = 1,
    ) -> Dict[str, Any]:
        """
        1 局面を解析して bestmove / PV / 評価値を返す
        """
        with self.lock:
            # 前回の探索が走ったまま/途中で止まった等で stdout に bestmove/info が残ると、
            # 次の局面の結果として誤読して『常に同じ bestmove』になりがち。
            # stop の bestmove を確実に吐かせ、isready の readyok まで読み切って同期する。
            pre_drain_lines: List[str] = []
            # 残り出力が混ざると次の解析結果を誤認するので、まず読み捨てる（best-effort）
            pre_drain_lines = self._drain_capture(max_total_ms=150)
            if self._last_multipv != multipv:
                self._send(f"setoption name MultiPV value {multipv}")
                self._send("isready")
                self._read_until_prefix("readyok")
                self._last_multipv = multipv

            # ここで readyok まで同期してから position を送る。
            # （position の後に isready を送ると、実装によっては局面が初期化されることがある）
            self._send("isready")
            self._read_until_prefix("readyok")

            position_cmd = self._build_position_cmd(sfen, moves)
            self._send(position_cmd)

            debug_expected_side = "black" if (len(moves) % 2 == 0) else "white"
            debug_engine_side: Optional[str] = None
            debug_effective_sfen: Optional[str] = None
            if self.verify_position:
                try:
                    self._send("side")
                    debug_engine_side = self._read_until_one_of({"black", "white"}, timeout_ms=300)
                    self._send("d")
                    debug_effective_sfen = self._read_sfen_from_d(timeout_ms=600)
                    # consume any remaining debug output
                    self._drain_until_quiet(max_total_ms=120)
                except Exception:
                    debug_engine_side = None
                    debug_effective_sfen = None

            go_mode = str(os.getenv("ENGINE_GO_MODE", "movetime")).lower().strip()
            if go_mode == "byoyomi":
                go_cmd = f"go btime 0 wtime 0 byoyomi {int(byoyomi)}"
            else:
                movetime_ms = max(1, int(byoyomi))
                go_cmd = f"go movetime {movetime_ms}"
            self._send(go_cmd)

            pv_map: Dict[int, Dict[str, Any]] = {}
            last_info: Optional[str] = None
            bestmove: Optional[str] = None
            ponder: Optional[str] = None

            while True:
                line = self._read_line()
                if not line:
                    continue

                if line.startswith("info"):
                    last_info = line
                    parsed = self._parse_info_line(line)
                    if parsed is not None:
                        pv_map[parsed["multipv"]] = parsed
                elif line.startswith("bestmove"):
                    parts = line.split()
                    if len(parts) >= 2:
                        bestmove = parts[1]
                    if len(parts) >= 4 and parts[2] == "ponder":
                        ponder = parts[3]
                    break

            pv_list = [pv_map[k] for k in sorted(pv_map.keys())] if pv_map else []

            main_score_cp = None
            main_score_mate = None
            main_pv: List[str] = []
            if pv_list:
                main = pv_list[0]
                main_score_cp = main.get("score_cp")
                main_score_mate = main.get("score_mate")
                main_pv = main.get("pv") or []

            return {
                "bestmove": bestmove,
                "ponder": ponder,
                "main_score_cp": main_score_cp,
                "main_score_mate": main_score_mate,
                "main_pv": main_pv,
                "multipv": pv_list,
                "last_info": last_info,
                "debug_position_cmd": position_cmd,
                "debug_go_cmd": go_cmd,
                "debug_sfen": sfen,
                "debug_moves": list(moves),
                "debug_expected_side": debug_expected_side,
                "debug_engine_side": debug_engine_side,
                "debug_effective_sfen": debug_effective_sfen,
                "debug_pre_drain_count": int(len(pre_drain_lines)) if pre_drain_lines is not None else None,
                "debug_pre_drain_tail": [l for l in (pre_drain_lines or []) if l.strip() != "readyok"][-5:],
                "debug_stderr_tail": list(self._stderr_tail)[-20:],
            }

    def quit(self) -> None:
        try:
            self._send("quit")
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except Exception:
            pass


class EnginePool:
    """
    YaneuraOuEngine を複数立ち上げてプールする。
    acquire() で空きインスタンスを 1 つ取り出し、使い終わったら release() で返却する。
    空きがない場合はブロックして待つので、自然にキューになる。
    """

    def __init__(self, size: int):
        self.size = size
        self.engines: List[YaneuraOuEngine] = []
        self.free_indices: "queue.Queue[int]" = queue.Queue()
        self._init_lock = threading.Lock()
        self._initialized = False

    def _init_engines(self) -> None:
        with self._init_lock:
            if self._initialized:
                return
            for i in range(self.size):
                e = YaneuraOuEngine(
                    engine_path=ENGINE_PATH,
                    workdir=ENGINE_DIR,
                    eval_dir=EVAL_DIR,
                    threads=ENGINE_THREADS,
                    hash_mb=ENGINE_HASH_MB,
                    fv_scale=FV_SCALE,
                )
                self.engines.append(e)
                self.free_indices.put(i)
            self._initialized = True

    def acquire(self) -> YaneuraOuEngine:
        if not self._initialized:
            self._init_engines()
        idx = self.free_indices.get(block=True)
        return self.engines[idx]

    def release(self, engine: YaneuraOuEngine) -> None:
        idx = self.engines.index(engine)
        self.free_indices.put(idx)

    def shutdown(self) -> None:
        for e in self.engines:
            e.quit()
        self.engines.clear()


app = FastAPI(title="YaneuraOu Hao Analysis Server (Engine Pool, 秒指定, 4 instances, local engine/)")


# ---- Engine server CIDR guard ----
# By default, engine server is restricted (ENGINE_SERVER_ALLOW_REMOTE=0).
# Use ENGINE_SERVER_ALLOWED_CIDRS to allow LAN/VPN ranges.
_ENGINE_SERVER_DEFAULT_ALLOWED_CIDRS = (    "127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,fd00::/8,fe80::/10")

_engine_cidr_src = None
_engine_cidr_nets = []

def _engine_bool_env(name: str, default: str = "0") -> bool:
    v = os.getenv(name, default)
    return str(v).strip().lower() in ("1", "true", "yes", "on")

def _engine_parse_allowed_cidrs(value: str):
    nets = []
    for part in (value or "").split(","):
        p = part.strip()
        if not p:
            continue
        try:
            nets.append(ipaddress.ip_network(p, strict=False))
        except Exception:
            continue
    return nets

def _engine_allowed_nets():
    global _engine_cidr_src, _engine_cidr_nets
    src = os.getenv("ENGINE_SERVER_ALLOWED_CIDRS", _ENGINE_SERVER_DEFAULT_ALLOWED_CIDRS)
    if src != _engine_cidr_src:
        _engine_cidr_src = src
        _engine_cidr_nets = _engine_parse_allowed_cidrs(src)
    return _engine_cidr_nets

def _engine_client_ip(request: Request) -> str:
    # If behind reverse proxy and ENGINE_SERVER_TRUST_PROXY=1, honor X-Forwarded-For (left-most)
    if _engine_bool_env("ENGINE_SERVER_TRUST_PROXY", "0"):
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    try:
        if request.client and request.client.host:
            return str(request.client.host)
    except Exception:
        pass
    return ""

@app.middleware("http")
async def _engine_server_cidr_guard(request: Request, call_next):
    # 1 => allow from anywhere, 0 => allow only from CIDR list
    if _engine_bool_env("ENGINE_SERVER_ALLOW_REMOTE", "0"):
        return await call_next(request)

    ip = _engine_client_ip(request)
    if not ip:
        return JSONResponse(status_code=403, content={"success": False, "error_code": "forbidden", "message": "forbidden"})

    ip_clean = ip.split("%")[0]
    try:
        addr = ipaddress.ip_address(ip_clean)
    except Exception:
        return JSONResponse(status_code=403, content={"success": False, "error_code": "forbidden", "message": "forbidden"})

    try:
        if any(addr in net for net in _engine_allowed_nets()):
            return await call_next(request)
    except Exception:
        pass

    return JSONResponse(status_code=403, content={"success": False, "error_code": "forbidden", "message": "forbidden"})

# ---- end engine server CIDR guard ----


class AnalyzeRequest(BaseModel):
    sfen: str
    moves: List[str] = Field(default_factory=list)
    think_seconds: float = 1.0   # 秒指定（デフォルト 1 秒）
    multipv: int = 1


class AnalyzeResponse(BaseModel):
    bestmove: Optional[str]
    ponder: Optional[str]
    main_score_cp: Optional[int]
    main_score_mate: Optional[int]
    main_pv: List[str] = Field(default_factory=list)
    multipv: List[Dict[str, Any]] = Field(default_factory=list)
    last_info: Optional[str]
    debug_position_cmd: Optional[str] = None
    debug_go_cmd: Optional[str] = None
    debug_sfen: Optional[str] = None
    debug_moves: List[str] = Field(default_factory=list)
    debug_expected_side: Optional[str] = None
    debug_engine_side: Optional[str] = None
    debug_effective_sfen: Optional[str] = None
    debug_pre_drain_count: Optional[int] = None
    debug_pre_drain_tail: List[str] = Field(default_factory=list)
    debug_stderr_tail: List[str] = Field(default_factory=list)



_engine_pool = EnginePool(size=ENGINE_INSTANCES)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    engine = _engine_pool.acquire()
    try:
        byoyomi_ms = max(1, int(req.think_seconds * 1000))
        result = engine.analyze(
            sfen=req.sfen,
            moves=req.moves,
            byoyomi=byoyomi_ms,
            multipv=req.multipv,
        )
        return AnalyzeResponse(**result)
    finally:
        _engine_pool.release(engine)


@app.on_event("shutdown")
def shutdown_event() -> None:
    _engine_pool.shutdown()
