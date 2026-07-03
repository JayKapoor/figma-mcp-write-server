"""Morph: flatten an IR tree into absolute-positioned paint leaves.

Usage: python flatten.py <captureDir>/ir.json [leaves.json]
Each leaf is one of:
  {t:text, x,y,w,h, s, fs, fw, col, fam, al, tt, lh}
  {t:rect, x,y,w,h, bg, rad, bd, z}
  {t:img,  x,y,w,h, ak, fit, rad, z}    ak = asset key into ir.assets
  {t:svg,  x,y,w,h, svg}
The builder places these absolutely, which gives pixel-accurate fidelity.
Auto-layout conversion (for editability) is a later pass.
"""
import json, sys, os


def flatten(ir):
    leaves = []

    def walk(n):
        x, y, w, h = n["box"]
        z = n.get("z")
        if "text" in n and n["text"].strip():
            f = n["font"]
            leaf = {"t": "text", "x": x, "y": y, "w": max(w, 1), "h": max(h, 1),
                    "s": n["text"][:300], "fs": f["size"], "fw": f["weight"],
                    "col": f["color"], "fam": f["family"], "al": f.get("align", "left"),
                    "tt": f.get("transform", "none")}
            lh = f.get("lh", "")
            if isinstance(lh, str) and lh.endswith("px"):
                leaf["lh"] = round(float(lh[:-2]), 1)
            leaves.append(leaf)
        elif "ak" in n or "img" in n or "bgImageUrl" in n or "video" in n:
            leaf = {"t": "img", "x": x, "y": y, "w": max(w, 1), "h": max(h, 1),
                    "ak": n.get("ak", ""), "fit": n.get("fit", "cover")}
            if n.get("radius"): leaf["rad"] = n["radius"]
            if z is not None: leaf["z"] = z
            leaves.append(leaf)
        elif "svg" in n and not n["svg"].startswith("TOO_LARGE") and len(n["svg"]) < 4000 and w >= 8 and h >= 8:
            leaves.append({"t": "svg", "x": x, "y": y, "w": w, "h": h, "svg": n["svg"]})
            return  # svg markup already contains its children
        elif "bg" in n and w >= 2 and h >= 2:
            leaf = {"t": "rect", "x": x, "y": y, "w": w, "h": h, "bg": n["bg"],
                    "rad": n.get("radius"), "bd": n.get("border")}
            if z is not None: leaf["z"] = z
            leaves.append(leaf)
        for c in n.get("children", []) or []:
            walk(c)

    walk(ir["tree"])
    # dedupe identical leaves (responsive SSR variants can double up)
    seen, uniq = set(), []
    for l in leaves:
        k = (l["t"], l["x"], l["y"], l.get("s"), l.get("bg"), l.get("ak"), l["w"])
        if k not in seen:
            seen.add(k); uniq.append(l)
    return dedupe_ssr_variants(uniq)


def _overlap(a, b):
    """Intersection area over the smaller leaf's area (0..1)."""
    ix = max(0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    smaller = min(a["w"] * a["h"], b["w"] * b["h"]) or 1
    return (ix * iy) / smaller


def dedupe_ssr_variants(leaves):
    """Framer SSR renders one subtree per responsive variant; when more than one
    is visible at capture, the same content paints twice at near-identical
    positions (the doubled wordmark bug). Drop a leaf when an already-kept leaf
    has the SAME content and overlaps it heavily. Repeated content at different
    positions (nav labels, VIEW ALL buttons) does not overlap, so it survives.
    """
    def content_key(l):
        if l["t"] == "text": return ("text", l["s"])
        if l["t"] == "img":  return ("img", l["ak"])
        if l["t"] == "svg":  return ("svg", l["svg"])
        # rects only dedupe against same-color same-size twins; nested
        # same-color panels are legitimate and get a distinct key via size
        return ("rect", l.get("bg"), round(l["w"] / 4), round(l["h"] / 4))

    kept_by_key, out, dropped = {}, [], 0
    for l in leaves:
        k = content_key(l)
        if any(_overlap(l, prev) > 0.5 for prev in kept_by_key.get(k, [])):
            dropped += 1
            continue
        kept_by_key.setdefault(k, []).append(l)
        out.append(l)
    if dropped:
        print(f"ssr-variant dedupe: dropped {dropped} overlapping duplicate leaves")
    return out


if __name__ == "__main__":
    ir_path = sys.argv[1]
    ir = json.load(open(ir_path))
    out = flatten(ir)
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(ir_path), "leaves.json")
    json.dump(out, open(out_path, "w"))
    counts = {t: sum(1 for l in out if l["t"] == t) for t in ("text", "img", "rect", "svg")}
    print(f"{len(out)} leaves -> {out_path} "
          f"({counts['text']} text, {counts['img']} img, {counts['rect']} rect, {counts['svg']} svg)")
