import os
import uuid
import gc
import imageio
import numpy as np
from IPython.display import Image as ImageDisplay

import torch
from notebook.inference import (
    Inference,
    ready_gaussian_for_video_rendering,
    load_image,
    load_masks,
    display_image,
    make_scene,
    render_video,
    interactive_visualizer,
)

if __name__ == "__main__":
    PATH = os.getcwd()
    TAG = "hf"
    config_path = f"./checkpoints/{TAG}/pipeline.yaml"
    inference = Inference(config_path, compile=False)
    
    IMAGE_PATH = f"./my_data_test/images/image.jpg"
    IMAGE_NAME = os.path.basename(os.path.dirname(IMAGE_PATH))
    
    GAUSS_MULTI_DIR = os.path.join(PATH, "output", "mytest")
    
        # might take a while to load (black screen)
    interactive_visualizer(os.path.join(GAUSS_MULTI_DIR, f"{IMAGE_NAME}.ply"))
