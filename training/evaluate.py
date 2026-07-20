#!/usr/bin/env python3
"""
SAGE Accident Detection - Model Evaluation Script
Evaluates trained YOLOv8n model on validation/test set.

Usage:
  python evaluate.py --weights runs/train/sage_accident/weights/best.pt
  python evaluate.py --weights runs/train/sage_accident/weights/best.pt --confusion-matrix
"""

import argparse
from pathlib import Path

from ultralytics import YOLO


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate trained model")
    parser.add_argument("--weights", required=True, help="Path to trained weights")
    parser.add_argument("--data", default="datasets.yaml", help="Dataset config")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.6, help="IoU threshold for NMS")
    parser.add_argument("--confusion-matrix", action="store_true", help="Generate confusion matrix")
    parser.add_argument("--device", default="", help="Device: cpu, 0, etc.")
    return parser.parse_args()


def evaluate(args):
    """Run evaluation on the trained model."""

    print("=" * 60)
    print("SAGE Accident Detection - Model Evaluation")
    print("=" * 60)
    print(f"Weights: {args.weights}")
    print(f"Dataset: {args.data}")
    print(f"Confidence: {args.conf}")
    print()

    model = YOLO(args.weights)

    # Run validation
    results = model.val(
        data=args.data,
        conf=args.conf,
        iou=args.iou,
        device=args.device or None,
        plots=args.confusion_matrix,
        verbose=True,
    )

    # Print key metrics
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"mAP@50:    {results.box.map50:.4f}")
    print(f"mAP@50-95: {results.box.map:.4f}")
    print(f"Precision: {results.box.mp:.4f}")
    print(f"Recall:    {results.box.mr:.4f}")
    print()

    # Per-class metrics
    print("Per-class metrics:")
    names = results.names
    for i, (p, r, ap50, ap) in enumerate(
        zip(results.box.p, results.box.r, results.box.ap50, results.box.ap)
    ):
        print(f"  {names[i]:20s}  P={p:.3f}  R={r:.3f}  AP50={ap50:.3f}  AP={ap:.3f}")

    print(f"\nResults saved to: {results.save_dir}")

    if args.confusion_matrix:
        print(f"Confusion matrix saved to: {results.save_dir}/confusion_matrix.png")

    return results


def main():
    args = parse_args()

    if not Path(args.weights).exists():
        print(f"Weights file not found: {args.weights}")
        print("Train the model first: python train.py")
        return

    evaluate(args)


if __name__ == "__main__":
    main()
