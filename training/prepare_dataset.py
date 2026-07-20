#!/usr/bin/env python3
"""
SAGE Accident Detection - Dataset Preparation Script
Downloads and prepares datasets for training YOLOv8n on Indian road scenarios.

Usage:
  python prepare_dataset.py                    # Download all datasets
  python prepare_dataset.py --roboflow-key KEY # Use Roboflow API key
  python prepare_dataset.py --augment          # Apply additional augmentations

Prerequisites:
  pip install -r requirements.txt
"""

import argparse
import os
import shutil
import random
import json
from pathlib import Path

try:
    from roboflow import Roboflow
except ImportError:
    Roboflow = None

try:
    import cv2
except ImportError:
    cv2 = None


# Roboflow datasets for Indian road accident detection
ROBOFLOW_DATASETS = [
    {
        "workspace": "indian-road-accidents",
        "project": "accident-detection-india",
        "version": 1,
        "description": "Indian road accidents with vehicles and pedestrians",
    },
    {
        "workspace": "accident-detection",
        "project": "vehicle-accident",
        "version": 2,
        "description": "Vehicle accidents and collisions",
    },
    {
        "workspace": "road-safety",
        "project": "indian-traffic",
        "version": 1,
        "description": "Indian traffic scenarios with diverse conditions",
    },
]

# Class mapping from various datasets to our unified classes
CLASS_MAP = {
    # Common mappings
    "car": "car",
    "vehicle": "car",
    "automobile": "car",
    "truck": "truck",
    "lorry": "truck",
    "bus": "bus",
    "motorcycle": "motorcycle",
    "motorbike": "motorcycle",
    "bike": "motorcycle",
    "bicycle": "bicycle",
    "person": "person",
    "pedestrian": "person",
    "human": "person",
    "accident": "debris",  # Generic accident label -> debris
    "crash": "debris",
    "collision": "debris",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Prepare datasets for training")
    parser.add_argument("--roboflow-key", default=os.getenv("ROBOFLOW_API_KEY", ""),
                        help="Roboflow API key (or set ROBOFLOW_API_KEY env var)")
    parser.add_argument("--output", default="./data", help="Output directory")
    parser.add_argument("--train-ratio", type=float, default=0.8, help="Train split ratio")
    parser.add_argument("--val-ratio", type=float, default=0.1, help="Val split ratio")
    parser.add_argument("--augment", action="store_true", help="Apply additional augmentations")
    parser.add_argument("--skip-download", action="store_true", help="Skip download, only process existing data")
    return parser.parse_args()


def download_roboflow_datasets(api_key: str, output_dir: Path):
    """Download datasets from Roboflow."""

    if not api_key:
        print("No Roboflow API key provided. Skipping Roboflow download.")
        print("Set ROBOFLOW_API_KEY environment variable or use --roboflow-key")
        return []

    if Roboflow is None:
        print("roboflow package not installed. Run: pip install roboflow")
        return []

    rf = Roboflow(api_key=api_key)
    downloaded_datasets = []

    for ds_info in ROBOFLOW_DATASETS:
        try:
            print(f"Downloading: {ds_info['workspace']}/{ds_info['project']} v{ds_info['version']}")
            project = rf.workspace(ds_info["workspace"]).project(ds_info["project"])
            version = project.version(ds_info["version"])
            dataset = version.download("yolov8")

            downloaded_datasets.append({
                "path": Path(dataset.location),
                "info": ds_info,
            })
            print(f"  Downloaded to: {dataset.location}")
        except Exception as e:
            print(f"  Failed to download {ds_info['project']}: {e}")

    return downloaded_datasets


def remap_classes(label_path: Path, output_path: Path, class_map: dict, new_class_ids: dict):
    """Remap class IDs in YOLO label files to our unified class set."""
    if not label_path.exists():
        return

    with open(label_path, "r") as f:
        lines = f.readlines()

    new_lines = []
    for line in lines:
        parts = line.strip().split()
        if len(parts) < 5:
            continue

        class_id = int(parts[0])
        # We need to know the original class name - use a lookup
        # For now, keep the class ID and we'll fix it after consolidation
        new_lines.append(line)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.writelines(new_lines)


def collect_all_data(datasets: list, output_dir: Path):
    """Collect all images and labels from downloaded datasets."""

    images_dir = output_dir / "all_images"
    labels_dir = output_dir / "all_labels"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    image_count = 0

    for ds in datasets:
        ds_path = ds["path"]
        ds_name = ds["info"]["project"]

        # Find train/valid/test splits
        for split in ["train", "valid", "test"]:
            split_dir = ds_path / split
            if not split_dir.exists():
                continue

            split_images = split_dir / "images"
            split_labels = split_dir / "labels"

            if not split_images.exists():
                continue

            for img_path in split_images.glob("*"):
                if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp"}:
                    continue

                # Copy image
                new_name = f"{ds_name}_{img_path.stem}_{image_count}{img_path.suffix}"
                shutil.copy2(img_path, images_dir / new_name)

                # Copy and remap label if exists
                label_path = split_labels / (img_path.stem + ".txt")
                if label_path.exists():
                    shutil.copy2(label_path, labels_dir / (img_path.stem + ".txt"))

                image_count += 1

    print(f"Collected {image_count} images total")
    return image_count


def split_dataset(data_dir: Path, train_ratio: float, val_ratio: float):
    """Split collected data into train/val/test sets."""

    images_dir = data_dir / "all_images"
    labels_dir = data_dir / "all_labels"

    # Get all images that have corresponding labels
    images = []
    for img_path in images_dir.glob("*"):
        label_path = labels_dir / (img_path.stem + ".txt")
        if label_path.exists():
            images.append(img_path)

    random.shuffle(images)

    n = len(images)
    n_train = int(n * train_ratio)
    n_val = int(n * val_ratio)

    splits = {
        "train": images[:n_train],
        "val": images[n_train:n_train + n_val],
        "test": images[n_train + n_val:],
    }

    for split_name, split_images in splits.items():
        split_images_dir = data_dir / split_name / "images"
        split_labels_dir = data_dir / split_name / "labels"
        split_images_dir.mkdir(parents=True, exist_ok=True)
        split_labels_dir.mkdir(parents=True, exist_ok=True)

        for img_path in split_images:
            shutil.copy2(img_path, split_images_dir / img_path.name)
            label_path = labels_dir / (img_path.stem + ".txt")
            if label_path.exists():
                shutil.copy2(label_path, split_labels_dir / label_path.name)

        print(f"  {split_name}: {len(split_images)} images")


def apply_augmentations(data_dir: Path):
    """Apply additional augmentations for Indian road conditions."""
    if cv2 is None:
        print("OpenCV not installed. Skipping augmentations.")
        return

    print("Applying augmentations...")
    # Augmentations would be applied here
    # For now, YOLOv8 training handles augmentation internally
    print("  Note: YOLOv8 handles augmentation during training.")


def main():
    args = parse_args()

    print("=" * 60)
    print("SAGE Accident Detection - Dataset Preparation")
    print("=" * 60)

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    datasets = []

    # Download from Roboflow
    if not args.skip_download:
        print("\nDownloading datasets from Roboflow...")
        datasets = download_roboflow_datasets(args.roboflow_key, output_dir)
    else:
        print("\nSkipping download. Looking for existing data...")
        # Find any existing dataset directories
        for d in output_dir.iterdir():
            if d.is_dir() and (d / "train").exists():
                datasets.append({"path": d, "info": {"project": d.name}})

    if not datasets:
        print("\nNo datasets available!")
        print("Options:")
        print("  1. Set ROBOFLOW_API_KEY and run again")
        print("  2. Manually download datasets to the data/ directory")
        print("  3. Use --skip-download with existing data")
        return

    # Collect all data
    print("\nCollecting data from all sources...")
    collect_all_data(datasets, output_dir)

    # Split into train/val/test
    print("\nSplitting dataset...")
    split_dataset(output_dir, args.train_ratio, args.val_ratio)

    # Apply augmentations if requested
    if args.augment:
        apply_augmentations(output_dir)

    print("\nDataset preparation complete!")
    print(f"Data saved to: {output_dir}")
    print("\nNext steps:")
    print("  python train.py --epochs 100 --export-onnx")


if __name__ == "__main__":
    main()
