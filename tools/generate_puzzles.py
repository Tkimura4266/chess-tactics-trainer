"""Generate data/puzzles.json from my own games (all games in the chess DB).

Puzzle types:
  mate_found      - I delivered mate
  mate_missed     - mate in 1 was available but I played something else
  material_found  - opponent blundered and I punished it with the best move
  material_missed - opponent blundered and I missed the punishing move

Positions from games that were already decided are skipped: if my eval before
the opponent's previous move was already beyond +-DECIDED_CP (or a forced mate
for either side), the puzzle is not used.

The daily report only analyses the first 15 moves of recent games
(ANALYSE_OPENING_ONLY in chess20260601/scripts/chess_daily_report.py), so the
remaining plies are analysed here with Stockfish (in parallel) and cached in
chess20260601/cache/fen_engine_cache_tactics_depth12.jsonl.

Usage: python tools/generate_puzzles.py
"""
import hashlib
import json
import multiprocessing as mp
import sys
from datetime import date
from pathlib import Path
from urllib.parse import quote

import chess
import chess.engine
import pandas as pd

SITE = Path(__file__).resolve().parent.parent
CHESS_DB = SITE.parent / "chess20260601"
DB_DIR = CHESS_DB / "database"
CACHE_DIR = CHESS_DB / "cache"
OUT = SITE / "data" / "puzzles.json"

STOCKFISH_PATH = r"C:\Users\tytka\Downloads\stockfish-windows-x86-64-avx2\stockfish\stockfish-windows-x86-64-avx2.exe"
ENGINE_DEPTH = 12
ENGINE_WORKERS = 8
ENGINE_THREADS = 2
MATE_SCORE_CP = 100000
MAIN_CACHE = CACHE_DIR / f"fen_engine_cache_depth{ENGINE_DEPTH}.jsonl"
TACTICS_CACHE = CACHE_DIR / f"fen_engine_cache_tactics_depth{ENGINE_DEPTH}.jsonl"

PER_TYPE = 10
BLUNDER_CP = 200    # opponent's move must swing the eval by at least this much
MISS_CP = 200       # my move must lose at least this much to count as a miss
DECIDED_CP = 500    # game counts as already decided beyond this eval, either side
CLIP = 1500         # clip evals so mate scores don't dominate swings


def clip(v):
    return max(-CLIP, min(CLIP, v))


def lichess_url(fen):
    return "https://lichess.org/analysis/standard/" + quote(fen.replace(" ", "_"), safe="_")


def cache_key(fen):
    return hashlib.sha1(f"{fen}|depth={ENGINE_DEPTH}".encode()).hexdigest()


def load_cache(path):
    cache = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                obj = json.loads(line)
                cache[obj["key"]] = obj
            except Exception:
                pass
    return cache


_engine = None


def _init_worker():
    global _engine
    _engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
    _engine.configure({"Threads": ENGINE_THREADS, "Hash": 64})


def analyse_fen(fen):
    b = chess.Board(fen)
    if b.is_game_over():
        if b.is_checkmate():
            cp = -MATE_SCORE_CP if b.turn == chess.WHITE else MATE_SCORE_CP
        else:
            cp = 0
        res = {"eval_cp_white": cp, "best_move_uci": None, "best_move_san": None}
    else:
        info = _engine.analyse(b, chess.engine.Limit(depth=ENGINE_DEPTH))
        pov = info["score"].white()
        if pov.is_mate():
            cp = MATE_SCORE_CP if pov.mate() > 0 else -MATE_SCORE_CP
        else:
            cp = int(pov.score(mate_score=MATE_SCORE_CP))
        bm = info["pv"][0] if info.get("pv") else None
        res = {"eval_cp_white": cp,
               "best_move_uci": bm.uci() if bm else None,
               "best_move_san": b.san(bm) if bm else None}
    return {"key": cache_key(fen), "fen": fen, "depth": ENGINE_DEPTH, **res}


def load_moves():
    """Analysed moves, plus engine analysis for plies the DB has not analysed."""
    analysed = pd.read_parquet(DB_DIR / f"moves_df_analysed_depth{ENGINE_DEPTH}.parquet")
    raw = pd.read_parquet(DB_DIR / "moves_df_raw.parquet")

    have = set(zip(analysed["game_id"], analysed["ply"]))
    todo = raw[~pd.Series(list(zip(raw["game_id"], raw["ply"])), index=raw.index).isin(have)].copy()
    if todo.empty:
        return analysed

    cache = load_cache(MAIN_CACHE)
    cache.update(load_cache(TACTICS_CACHE))
    fens = pd.unique(pd.concat([todo["fen_before"], todo["fen_after"]]))
    missing = [f for f in fens if cache_key(f) not in cache]
    print(f"Extra plies: {len(todo)}  FENs: {len(fens)}  to analyse: {len(missing)}", flush=True)
    if missing:
        with mp.Pool(ENGINE_WORKERS, initializer=_init_worker) as pool, \
                open(TACTICS_CACHE, "a", encoding="utf-8") as f:
            for i, obj in enumerate(pool.imap_unordered(analyse_fen, missing, chunksize=16), 1):
                cache[obj["key"]] = obj
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
                if i % 1000 == 0:
                    f.flush()
                    print(f"  {i}/{len(missing)}", flush=True)

    get = lambda fen: cache[cache_key(fen)]
    sign = todo["my_color"].map({"white": 1, "black": -1})
    todo["eval_before_cp_white"] = todo["fen_before"].map(lambda f: get(f)["eval_cp_white"])
    todo["eval_after_cp_white"] = todo["fen_after"].map(lambda f: get(f)["eval_cp_white"])
    todo["best_move_uci"] = todo["fen_before"].map(lambda f: get(f)["best_move_uci"])
    todo["best_move_san"] = todo["fen_before"].map(lambda f: get(f)["best_move_san"])
    todo["eval_before_cp"] = todo["eval_before_cp_white"] * sign
    todo["eval_after_cp"] = todo["eval_after_cp_white"] * sign
    todo["drop_cp"] = todo["eval_before_cp"] - todo["eval_after_cp"]
    return pd.concat([analysed, todo[analysed.columns]], ignore_index=True)


def main():
    df = load_moves()
    df = df.sort_values(["game_no", "ply"]).reset_index(drop=True)
    by_game = df.groupby("game_id")
    df["prev_san"] = by_game["san"].shift(1)
    df["prev_uci"] = by_game["uci"].shift(1)
    df["prev_is_my"] = by_game["is_my_move"].shift(1)
    df["prev_eval_before"] = by_game["eval_before_cp"].shift(1)

    mine = df[(df["is_my_move"] == True) & df["eval_before_cp"].notna()
              & df["prev_eval_before"].notna()].copy()
    ev_before = mine["eval_before_cp"].map(clip)
    swing_prev = ev_before - mine["prev_eval_before"].map(clip)
    my_drop = ev_before - mine["eval_after_cp"].map(clip)
    is_best = mine["uci"] == mine["best_move_uci"]
    played_mate = mine["san"].astype(str).str.endswith("#")
    best_mate = mine["best_move_san"].astype(str).str.endswith("#")
    best_tactical = mine["best_move_san"].astype(str).str.contains(r"x|\+")
    opp_blunder = (mine["prev_is_my"] == False) & (swing_prev >= BLUNDER_CP)
    not_decided = mine["prev_eval_before"].abs() < DECIDED_CP
    still_mating = mine["eval_after_cp"] >= MATE_SCORE_CP

    groups = {
        "mate_found": mine[not_decided & played_mate],
        "mate_missed": mine[not_decided & best_mate & ~played_mate & ~still_mating],
        "material_found": mine[not_decided & opp_blunder & is_best & best_tactical
                               & ~played_mate & ~best_mate],
        "material_missed": mine[not_decided & opp_blunder & ~is_best & best_tactical
                                & (my_drop >= MISS_CP) & ~best_mate],
    }

    puzzles = []
    for ptype, rows in groups.items():
        # newest first, one puzzle per game
        rows = rows.sort_values(["game_no", "ply"], ascending=False).drop_duplicates("game_id")
        print(f"{ptype}: {len(rows)} candidate games", flush=True)
        for _, r in rows.head(PER_TYPE).iterrows():
            opponent = r["black"] if r["my_color"] == "white" else r["white"]
            if ptype == "mate_found":
                ev = (MATE_SCORE_CP, -MATE_SCORE_CP)
            elif ptype == "mate_missed":
                ev = (MATE_SCORE_CP, r["eval_after_cp"])
            elif ptype == "material_found":
                ev = (r["prev_eval_before"], r["eval_after_cp"])
            else:
                ev = (r["eval_before_cp"], r["eval_after_cp"])
            puzzles.append({
                "type": ptype,
                "fen": r["fen_before"],
                "orientation": r["my_color"],
                "san": r["san"],
                "uci": r["uci"],
                "best_san": r["best_move_san"],
                "best_uci": r["best_move_uci"],
                "prev_san": r["prev_san"] if isinstance(r["prev_san"], str) else None,
                "prev_uci": r["prev_uci"] if isinstance(r["prev_uci"], str) else None,
                "opponent": opponent,
                "date": r["date"],
                "opening": r["opening_family"] if isinstance(r["opening_family"], str) else "",
                "eval_before": int(ev[0]),
                "eval_after": int(ev[1]),
                "eval_prev": int(r["prev_eval_before"]),
                "lichess_url": lichess_url(r["fen_before"]),
                "game_url": r["url"],
            })
    puzzles = [{"id": i, **p} for i, p in enumerate(puzzles, 1)]

    data = {
        "generated_at": date.today().isoformat(),
        "source": (f"my games, newest {PER_TYPE} each, excluding already-decided games "
                   f"(|eval| before opponent's move < {DECIDED_CP}cp)"),
        "puzzles": puzzles,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {t: sum(p["type"] == t for p in puzzles) for t in groups}
    dates = sorted(p["date"] for p in puzzles)
    print(f"Wrote {len(puzzles)} puzzles to {OUT}  {counts}  dates {dates[0]}..{dates[-1]}")


if __name__ == "__main__":
    sys.exit(main())
