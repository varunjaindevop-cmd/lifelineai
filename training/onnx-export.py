#!/usr/bin/env python3
"""
SAGE Accident Detection - ONNX Export Script
Exports trained YOLOv8n model to ONNX format for browser inference.

Usage:
  python onnx-export.py --weights runs/train/sage_accident/weights/best.pt
  python onnx-export.py --weights runs/train/sage_accident/weights/best.pt --quantize
"""

import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO


def parse_args():
    parser = argparse.ArgumentParser(description="Export model to ONNX")
    parser.add_argument("--weights", required=True, help="Path to trained weights (.pt)")
    parser.add_argument("--output", default="../public/models", help="Output directory")
    parser.add_argument("--imgsz", type=int, default=640, help="Input image size")
    parser.add_argument("--quantize", action="store_true", help="Also create INT8 quantized version")
    parser.add_argument("--simplify", action="store_true", default=True, help="Simplify ONNX graph")
    return parser.parse_args()


def export_onnx(args):
    """Export model to ONNX format."""

    print("=" * 60)
    print("SAGE Accident Detection - ONNX Export")
    print("=" * 60)
    print(f"Weights: {args.weights}")
    print(f"Output: {args.output}")
    print(f"Image size: {args.imgsz}")
    print()

    model = YOLO(args.weights)

    # Export to ONNX
    print("Exporting to ONNX...")
    result = model.export(
        format="onnx",
        imgsz=args.imgsz,
        simplify=args.simplify,
        opset=13,        # ONNX opset 13 for broad compatibility
        dynamic=False,   # Static shapes for faster inference
        half=False,      # FP32 for browser compatibility
    )

    print(f"ONNX exported to: {result}")

    # Copy to public/models
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    onnx_path = Path(result)
    dest = output_dir / "yolov8n-indian.onnx"
    shutil.copy2(onnx_path, dest)
    print(f"Copied to: {dest}")

    # Quantize if requested
    if args.quantize:
        try:
            from onnxruntime.quantization import quantize_dynamic, QuantType

            quantized_path = output_dir / "yolov8n-indian-int8.onnx"
            print(f"\nQuantizing to INT8...")
            quantize_dynamic(
                model_input=str(dest),
                model_output=str(quantized_path),
                weight_type=QuantType.QUInt8,
            )
            print(f"Quantized model: {quantized_path}")
        except Exception as e:
            print(f"Quantization failed: {e}")
            print("FP32 model is still available.")

    # Verify model loads correctly
    try:
        import onnxruntime as ort
        session = ort.InferenceSession(str(dest))
        input_name = session.get_inputs()[0].name
        input_shape = session.get_inputs()[0].shape
        print(f"\nVerification passed!")
        print(f"  Input: {input_name}, shape: {input_shape}")
        print(f"  Output: {session.get_outputs()[0].name}")
    except Exception as e:
        print(f"\nWarning: Could not verify ONNX model: {e}")

    print(f"\nDeploy by copying {dest} to your Next.js public/models/ directory")


def main():
    args = parse_args()

    if not Path(args.weights).exists():
        print(f"Weights file not found: {args.weights}")
        print("Train the model first: python train.py --export-onnx")
        return

    export_onnx(args)


if __name__ == "__main__":
    main()
