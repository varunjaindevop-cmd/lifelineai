# SAGE Accident Detection - Training Datasets

## Public Datasets for Indian Road Accident Detection

### 1. DAAD (Detection of Accidents in Autonomous Driving)
- **URL**: https://github.com/niaeinksaz/DAAD-Autonomous-Driving-Accident-Detection
- **Content**: Accident images from autonomous driving perspective
- **Classes**: accident, near-accident, no-accident
- **Size**: ~2,000 images
- **Use**: Fine-tune YOLOv8n for collision detection

### 2. CADP (Collision Avoidance Dataset for Pedestrians)
- **URL**: https://github.com/a1isy/mot17-pedestrian-avoidance
- **Content**: Pedestrian near-miss and collision scenarios
- **Classes**: pedestrian, vehicle, collision-frame
- **Use**: Train pedestrian-vehicle collision detection

### 3. DAD (Dataset for Accident Detection)
- **URL**: https://data.mendeley.com/datasets/k2ph2v5856/1
- **Content**: Dashboard camera accident videos
- **Size**: ~1,000 video clips
- **Use**: Video-level accident classification

### 4. ROBOFLOW Indian Traffic Datasets
- **URL**: https://roboflow.com/search?q=indian+traffic
- **Content**: Indian road scenes with annotations
- **Use**: Fine-tune for Indian vehicle types (auto-rickshaw, two-wheelers)

### 5. Indian Driving Dataset (IDD)
- **URL**: https://idd.insaan.iith.ac.in/
- **Content**: 10,000+ frames from Indian roads
- **Classes**: 34 classes including Indian-specific (auto-rickshaw, animals)
- **Use**: Domain adaptation for Indian roads

### 6. Mapillary Vistas (Street-level)
- **URL**: https://www.mapillary.com/dataset/vistas
- **Content**: 25,000 annotated street-level images
- **Use**: General road scene understanding

### 7. BDD100K (Berkeley DeepDrive)
- **URL**: https://bdd-data.berkeley.edu/
- **Content**: 100K driving videos with annotations
- **Classes**: 10 classes including person, vehicle, motorcycle
- **Use**: Vehicle and pedestrian detection

## Training Pipeline

### Step 1: Dataset Preparation
```bash
cd training
python prepare_dataset.py --source roboflow --query "indian road accident"
```

### Step 2: Custom YOLOv8n Training
```bash
python train.py --epochs 100 --batch 16 --imgsz 640
```

### Step 3: Export to ONNX (for browser)
```bash
python onnx-export.py --weights runs/train/sage_accident/weights/best.pt
```

### Step 4: Deploy to public/models/
Copy the exported ONNX file to your Next.js public/models/ directory

## Custom Classes for Training

```yaml
# datasets.yaml
names:
  0: car
  1: truck
  2: bus
  3: motorcycle
  4: bicycle
  5: person
  6: bike_fallen      # Motorcycle lying on side
  7: person_down      # Person lying on ground
  8: vehicle_fire     # Fire/smoke from vehicle
  9: debris           # Scattered vehicle parts
```

## Data Augmentation for Indian Roads

- Rain/fog simulation
- Night driving conditions
- Dust/haze (common in Indian cities)
- Varying camera angles (CCTV perspectives)
- Indian vehicle types (auto-rickshaw, cycle-rickshaw)
- Indian road conditions (potholes, uneven surfaces)
