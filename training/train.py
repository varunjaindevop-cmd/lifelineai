#!/usr/bin/env python3
"""
SAGE Accident Detection - YOLOv8n Training Script
Trains a custom model for Indian road accident detection.

Usage:
  python train.py                    # Train with default settings
  python train.py --epochs 200       # Train for more epochs
  python train.py --resume           # Resume from last checkpoint
  python train.py --export-onnx      # Export trained model to ONNX

Prerequisites:
  pip install -r requirements.txt
  python prepare_dataset.py          # Download and prepare datasets
"""

import argparse
import os
import sys
from pathlib import Path

from ultralytics import YOLO


def parse_args():
    parser = argparse.ArgumentParser(description="Train YOLOv8n for accident detection")
    parser.add_argument("--model", default="yolov8n.pt", help="Base model (default: yolov8n.pt)")
    parser.add_argument("--data", default="datasets.yaml", help="Dataset config path")
    parser.add_argument("--epochs", type=int, default=100, help="Training epochs (default: 100)")
    parser.add_argument("--batch", type=int, default=16, help="Batch size (default: 16)")
    parser.add_argument("--imgsz", type=int, default=640, help="Image size (default: 640)")
    parser.add_argument("--lr0", type=float, default=0.01, help="Initial learning rate (default: 0.01)")
    parser.add_argument("--patience", type=int, default=30, help="Early stopping patience (default: 30)")
    parser.add_argument("--device", default="", help="Device: cpu, 0, 0,1, etc.")
    parser.add_argument("--resume", action="store_true", help="Resume training from last checkpoint")
    parser.add_argument("--export-onnx", action="store_true", help="Export trained model to ONNX")
    parser.add_argument("--project", default="runs/train", help="Save directory")
    parser.add_argument("--name", default="sage_accident", help="Experiment name")
    return parser.parse_args()


def train(args):
    """Train YOLOv8n on Indian road accident dataset."""

    # Initialize model
    model = YOLO(args.model)

    # Training configuration optimized for accident detection
    results = model.train(
        data=args.data,
        epochs=args.epochs,
        batch=args.batch,
        imgsz=args.imgsz,
        lr0=args.lr0,
        patience=args.patience,
        device=args.device or None,
        resume=args.resume,
        project=args.project,
        name=args.name,

        # Augmentation (important for Indian road conditions)
        augment=True,
        hsv_h=0.015,      # Hue augmentation (rain, fog color shifts)
        hsv_s=0.7,         # Saturation augmentation
        hsv_v=0.4,         # Brightness augmentation (night driving)
        degrees=10.0,      # Rotation (camera angle variation)
        translate=0.1,     # Translation
        scale=0.5,         # Scale augmentation
        shear=2.0,         # Shear
        perspective=0.001, # Perspective (slight camera tilt)
        flipud=0.0,        # No vertical flip (roads don't flip)
        fliplr=0.5,        # Horizontal flip
        mosaic=1.0,        # Mosaic augmentation (combine 4 images)
        mixup=0.1,         # Mixup augmentation
        copy_paste=0.1,    # Copy-paste augmentation (rare objects)

        # Class weights to handle class imbalance
        # person_down and bike_fallen are rare but critical
        classes=None,      # Use all classes

        # Optimization
        optimizer="auto",  # SGD with momentum
        cos_lr=True,       # Cosine learning rate schedule
        warmup_epochs=3,   # Warm up for 3 epochs

        # Validation
        val=True,
        save_period=10,    # Save checkpoint every 10 epochs

        # Workers
        workers=4,
        exist_ok=False,    # Don't overwrite previous runs
        verbose=True,
    )

    print(f"\nTraining complete! Results saved to: {results.save_dir}")
    print(f"Best weights: {results.save_dir}/weights/best.pt")

    return results


def export_onnx(weights_path: str, output_dir: str = "../public/models"):
    """Export trained model to ONNX format for browser use."""

    print(f"\nExporting to ONNX: {weights_path}")

    model = YOLO(weights_path)

    # Export with optimization for browser inference
    model.export(
        format="onnx",
        imgsz=640,
        simplify=True,       # Simplify the ONNX graph
        opset=13,            # ONNX opset 13 (wide compatibility)
        dynamic=False,       # Static shapes for faster inference
        half=False,          # FP32 for compatibility (no FP16 in all browsers)
    )

    # Copy to public/models for web serving
    onnx_path = Path(weights_path).with_suffix(".onnx")
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    import shutil
    dest = output_path / "yolov8n-indian.onnx"
    shutil.copy2(onnx_path, dest)
    print(f"ONNX model exported to: {dest}")

    # Also create a quantized version (INT8) for faster inference
    try:
        import onnxruntime as ort
        import onnx
        from onnxruntime.quantization import quantize_dynamic, QuantType

        quantized_path = output_path / "yolov8n-indian-int8.onnx"
        quantize_dynamic(
            model_input=str(dest),
            model_output=str(quantized_path),
            weight_type=QuantType.QUInt8,
        )
        print(f"INT8 quantized model exported to: {quantized_path}")
    except Exception as e:
        print(f"Warning: INT8 quantization failed: {e}")
        print("FP32 ONNX model is still available.")


def main():
    args = parse_args()

    # Check if dataset exists
    data_path = Path(args.data)
    if not data_path.exists():
        print(f"Dataset config not found: {data_path}")
        print("Please run: python prepare_dataset.py")
        sys.exit(1)

    # Train
    print("=" * 60)
    print("SAGE Accident Detection - YOLOv8n Training")
    print("=" * 60)
    print(f"Model: {args.model}")
    print(f"Dataset: {args.data}")
    print(f"Epochs: {args.epochs}")
    print(f"Batch size: {args.batch}")
    print(f"Image size: {args.imgsz}")
    print()

    results = train(args)

    # Export to ONNX if requested
    if args.export_onnx:
        best_weights = str(Path(results.save_dir) / "weights" / "best.pt")
        export_onnx(best_weights)


if __name__ == "__main__":
    main()
