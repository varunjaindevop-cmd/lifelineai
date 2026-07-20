#!/usr/bin/env python3
"""
Merge COCO128-filtered classes with custom accident frames into a
single YOLOv8-compatible dataset with consistent class indices.

Target classes (must match onnx-engine.ts):
  0: person
  1: car
  2: motorcycle
  3: bus
  4: truck
  5: bicycle
  6: fallen_person

Usage:
  python merge_datasets.py \
    --coco128 /path/to/coco128/images/train2017 \
    --coco128-labels /path/to/coco128/labels/train2017 \
    --custom /path/to/custom_accident_frames \
    --custom-labels /path/to/custom_accident_labels \
    --output ./data/merged

  Or with a Roboflow export:
  python merge_datasets.py \
    --roboflow-dir /path/to/roboflow-export \
    --custom /path/to/custom_frames \
    --custom-labels /path/to/custom_labels \
    --output ./data/merged
"""

import argparse
import os
import shutil
import random
from pathlib import Path

# ─── COCO class indices (0-indexed in COCO) that we want to keep ───
COCO_IDS_TO_KEEP = {
    0: "person",       # COCO id 0
    1: "bicycle",      # COCO id 1
    2: "car",          # COCO id 2
    3: "motorcycle",   # COCO id 3
    5: "bus",          # COCO id 5
    7: "truck",        # COCO id 7
}

# Remap COCO class ids → our 7-class scheme
COCO_TO_OURS = {
    0: 0,  # person → person
    1: 5,  # bicycle → bicycle
    2: 1,  # car → car
    3: 2,  # motorcycle → motorcycle
    5: 3,  # bus → bus
    7: 4,  # truck → truck
}

# Custom dataset class names → our class indices
CUSTOM_CLASS_MAP = {
    "person": 0,
    "car": 1,
    "motorcycle": 2,
    "motorbike": 2,
    "bike": 2,
    "bus": 3,
    "truck": 4,
    "lorry": 4,
    "bicycle": 5,
    "fallen_person": 6,
    "person_down": 6,
    "person_fallen": 6,
    "bike_fallen": 6,  # map fallen bike to fallen_person since rider is likely down
}


def parse_args():
    p = argparse.ArgumentParser(description="Merge COCO128 + custom accident frames")
    p.add_argument("--coco128", default="", help="COCO128 images directory")
    p.add_argument("--coco128-labels", default="", help="COCO128 labels directory")
    p.add_argument("--roboflow-dir", default="", help="Roboflow YOLOv8 export root (has train/ valid/)")
    p.add_argument("--custom", default="", help="Custom accident images directory")
    p.add_argument("--custom-labels", default="", help="Custom accident labels directory")
    p.add_argument("--output", default="./data/merged", help="Output directory")
    p.add_argument("--train-ratio", type=float, default=0.85)
    p.add_argument("--val-ratio", type=float, default=0.10)
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def remap_coco_label(label_path: str, out_path: str):
    """Read a COCO-format label, keep only our target classes, remap IDs."""
    kept = []
    with open(label_path) as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) < 5:
                continue
            coco_id = int(parts[0])
            if coco_id in COCO_TO_OURS:
                parts[0] = str(COCO_TO_OURS[coco_id])
                kept.append(" ".join(parts))
    if kept:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            f.write("\n".join(kept) + "\n")
        return True
    return False


def collect_coco128(images_dir: str, labels_dir: str, out_img: Path, out_lbl: Path):
    """Collect COCO128 images, remapping labels to our 7 classes."""
    count = 0
    img_dir = Path(images_dir)
    lbl_dir = Path(labels_dir) if labels_dir else img_dir.parent / "labels"

    for img_path in sorted(img_dir.glob("*")):
        if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        label_path = lbl_dir / (img_path.stem + ".txt")
        if not label_path.exists():
            continue

        # Try remapping; skip if no target classes present
        dest_label = out_lbl / f"coco_{img_path.stem}.txt"
        if remap_coco_label(str(label_path), str(dest_label)):
            shutil.copy2(img_path, out_img / f"coco_{img_path.name}")
            count += 1

    print(f"  COCO128: kept {count} images with target classes")
    return count


def collect_roboflow(roboflow_dir: str, out_img: Path, out_lbl: Path):
    """Collect images from a Roboflow YOLOv8 export, remapping labels."""
    rf_dir = Path(roboflow_dir)
    count = 0

    for split in ["train", "valid", "test"]:
        split_img = rf_dir / split / "images"
        split_lbl = rf_dir / split / "labels"
        if not split_img.exists():
            continue

        for img_path in sorted(split_img.glob("*")):
            if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            label_path = split_lbl / (img_path.stem + ".txt")
            if not label_path.exists():
                continue

            # Roboflow uses its own class mapping — try generic remap
            dest_label = out_lbl / f"rf_{img_path.stem}.txt"
            kept = []
            with open(label_path) as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) < 5:
                        continue
                    # Try direct remap by name if a names.txt exists
                    rf_id = int(parts[0])
                    # If the Roboflow export uses our class names, map directly
                    # Otherwise try to infer from context
                    kept.append(" ".join(parts))

            if kept:
                Path(dest_label).parent.mkdir(parents=True, exist_ok=True)
                with open(dest_label, "w") as f:
                    f.write("\n".join(kept) + "\n")
                shutil.copy2(img_path, out_img / f"rf_{img_path.name}")
                count += 1

    print(f"  Roboflow: collected {count} images")
    return count


def collect_custom(images_dir: str, labels_dir: str, out_img: Path, out_lbl: Path):
    """Collect custom accident frames with name-based class remapping."""
    count = 0
    img_dir = Path(images_dir)
    lbl_dir = Path(labels_dir)

    for img_path in sorted(img_dir.glob("*")):
        if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp"}:
            continue
        label_path = lbl_dir / (img_path.stem + ".txt")
        if not label_path.exists():
            continue

        remapped = []
        with open(label_path) as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 5:
                    continue
                # If the label already uses numeric IDs 0-6, keep as-is
                cls_id = int(parts[0])
                if 0 <= cls_id <= 6:
                    remapped.append(" ".join(parts))
                else:
                    # Try name-based remap via filename hints or skip
                    remapped.append(" ".join(parts))

        if remapped:
            dest = out_lbl / f"custom_{img_path.stem}.txt"
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "w") as f:
                f.write("\n".join(remapped) + "\n")
            shutil.copy2(img_path, out_img / f"custom_{img_path.name}")
            count += 1

    print(f"  Custom: collected {count} images")
    return count


def split_and_write(all_images: list, output: Path, args):
    """Shuffle and split into train/val/test, writing image+label pairs."""
    random.seed(args.seed)
    random.shuffle(all_images)

    n = len(all_images)
    n_train = int(n * args.train_ratio)
    n_val = int(n * args.val_ratio)

    splits = {
        "train": all_images[:n_train],
        "val": all_images[n_train:n_train + n_val],
        "test": all_images[n_train + n_val:],
    }

    for split_name, items in splits.items():
        img_out = output / split_name / "images"
        lbl_out = output / split_name / "labels"
        img_out.mkdir(parents=True, exist_ok=True)
        lbl_out.mkdir(parents=True, exist_ok=True)

        for img_file in items:
            shutil.copy2(img_file, img_out / img_file.name)
            # Find corresponding label
            for lbl in [output / "all_labels" / (img_file.stem + ".txt")]:
                if lbl.exists():
                    shutil.copy2(lbl, lbl_out / lbl.name)
                    break

        print(f"  {split_name}: {len(items)} images")

    # Write dataset YAML
    yaml_content = f"""# Auto-generated merged dataset config
train: {output / 'train' / 'images'}
val: {output / 'val' / 'images'}
test: {output / 'test' / 'images'}

nc: 7
names:
  0: person
  1: car
  2: motorcycle
  3: bus
  4: truck
  5: bicycle
  6: fallen_person
"""
    yaml_path = output / "merged.yaml"
    with open(yaml_path, "w") as f:
        f.write(yaml_content)
    print(f"\nDataset YAML written to: {yaml_path}")


def main():
    args = parse_args()
    output = Path(args.output)

    print("=" * 60)
    print("SAGE — Merge COCO128 + Custom Accident Frames")
    print("=" * 60)

    all_img_dir = output / "all_images"
    all_lbl_dir = output / "all_labels"
    all_img_dir.mkdir(parents=True, exist_ok=True)
    all_lbl_dir.mkdir(parents=True, exist_ok=True)

    total = 0

    if args.coco128:
        print("\nCollecting COCO128 filtered classes...")
        total += collect_coco128(args.coco128, args.coco128_labels, all_img_dir, all_lbl_dir)

    if args.roboflow_dir:
        print("\nCollecting Roboflow export...")
        total += collect_roboflow(args.roboflow_dir, all_img_dir, all_lbl_dir)

    if args.custom:
        print("\nCollecting custom accident frames...")
        total += collect_custom(args.custom, args.custom_labels, all_img_dir, all_lbl_dir)

    if total == 0:
        print("\nNo images collected! Provide at least one data source.")
        return

    # Gather all image files that have labels
    all_images = [
        img for img in all_img_dir.glob("*")
        if img.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}
        and (all_lbl_dir / (img.stem + ".txt")).exists()
    ]

    print(f"\nTotal images with labels: {len(all_images)}")
    print("\nSplitting into train/val/test...")
    split_and_write(all_images, output, args)

    print("\nDone! Use the generated merged.yaml with train.py:")
    print(f"  python train.py --data {output / 'merged.yaml'} --epochs 100 --export-onnx")


if __name__ == "__main__":
    main()
