// Model catalog — curated set of frequently-needed weights with canonical
// HF URLs. The Settings → Model Library UI surfaces these as one-click
// installs. Users can also paste arbitrary URLs through the Custom form.
//
// Adding entries:
//   - source: 'hf' for HuggingFace (resolve URL via `huggingface.co/<repo>/
//     resolve/<branch>/<path>`). 'civitai' for Civitai (use the api/download
//     URL pattern; user must provide an API token at request time).
//   - target_subpath is relative to /opt/ComfyUI/models/ on the Modal Volume.
//   - size_mb is approximate, for UI display only.
//   - gated:true means the source needs an HF token to download. We still
//     attempt the request — user can paste an HF token in Settings.

export type ModelCategory =
  | 'checkpoints'        // SD 1.5 / SDXL full checkpoints
  | 'diffusion_models'   // Flux UNets
  | 'vae'                // VAEs
  | 'text_encoders'      // CLIP / T5 / Flux encoders
  | 'loras'              // LoRA adapters
  | 'controlnet'         // ControlNet weights
  | 'upscale_models';    // ESRGAN / upscaler weights

export type CatalogSource = 'hf' | 'civitai';

export interface CatalogModel {
  id: string;
  name: string;
  category: ModelCategory;
  source: CatalogSource;
  url: string;                      // canonical download URL
  target_subpath: string;            // dest relative to /opt/ComfyUI/models/
  size_mb: number;                   // approximate, for UI
  description: string;
  gated?: boolean;                   // requires HF token
  license?: string;
  recommended_for?: string[];        // e.g. ['flux', 'sdxl']
}

export const CATALOG: CatalogModel[] = [
  // ── Flux base diffusion models ──────────────────────────────────────────
  {
    id: 'flux1-dev-fp8',
    name: 'FLUX.1 dev (FP8)',
    category: 'diffusion_models',
    source: 'hf',
    url: 'https://huggingface.co/Kijai/flux-fp8/resolve/main/flux1-dev-fp8.safetensors',
    target_subpath: 'diffusion_models/flux1-dev-fp8.safetensors',
    size_mb: 11900,
    description: 'Black Forest Labs FLUX.1-dev, quantized to FP8 for ≤16 GB VRAM.',
    license: 'FLUX.1-dev non-commercial',
    recommended_for: ['flux'],
  },
  {
    id: 'flux1-schnell-fp8',
    name: 'FLUX.1 schnell (FP8)',
    category: 'diffusion_models',
    source: 'hf',
    url: 'https://huggingface.co/Kijai/flux-fp8/resolve/main/flux1-schnell-fp8.safetensors',
    target_subpath: 'diffusion_models/flux1-schnell-fp8.safetensors',
    size_mb: 11900,
    description: 'Distilled 4-step variant of FLUX.1. Faster inference, slightly lower fidelity.',
    license: 'Apache 2.0',
    recommended_for: ['flux'],
  },

  {
    id: 'flux1-dev-full',
    name: 'FLUX.1 dev (full / bf16)',
    category: 'diffusion_models',
    source: 'hf',
    url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors',
    target_subpath: 'diffusion_models/flux1-dev.safetensors',
    size_mb: 23800,
    description: 'Black Forest Labs FLUX.1-dev, full bf16 weights. Highest fidelity; needs ~24 GB VRAM (A10G/L40S/A100, not T4). Gated — requires an HF token with access granted.',
    gated: true,
    license: 'FLUX.1-dev non-commercial',
    recommended_for: ['flux'],
  },
  {
    id: 'flux1-schnell-full',
    name: 'FLUX.1 schnell (full / bf16)',
    category: 'diffusion_models',
    source: 'hf',
    url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/flux1-schnell.safetensors',
    target_subpath: 'diffusion_models/flux1-schnell.safetensors',
    size_mb: 23800,
    description: 'Distilled 4-step FLUX.1-schnell, full bf16 weights. Faster than dev; needs ~24 GB VRAM. Gated download — requires an HF token.',
    gated: true,
    license: 'Apache 2.0',
    recommended_for: ['flux'],
  },

  // ── Flux text encoders ──────────────────────────────────────────────────
  {
    id: 'flux-clip-l',
    name: 'CLIP-L (for Flux)',
    category: 'text_encoders',
    source: 'hf',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
    target_subpath: 'text_encoders/clip_l.safetensors',
    size_mb: 246,
    description: 'OpenAI CLIP-L. Required by Flux + several other workflows.',
    recommended_for: ['flux'],
  },
  {
    id: 'flux-t5xxl-fp8',
    name: 'T5-XXL FP8 (for Flux)',
    category: 'text_encoders',
    source: 'hf',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
    target_subpath: 'text_encoders/t5xxl_fp8_e4m3fn.safetensors',
    size_mb: 4890,
    description: 'T5-XXL text encoder, FP8 quant. Required by Flux dev/schnell.',
    recommended_for: ['flux'],
  },
  {
    id: 'flux-t5xxl-fp16',
    name: 'T5-XXL FP16 (for Flux)',
    category: 'text_encoders',
    source: 'hf',
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors',
    target_subpath: 'text_encoders/t5xxl_fp16.safetensors',
    size_mb: 9790,
    description: 'T5-XXL text encoder, FP16. Higher fidelity but needs >16 GB VRAM with Flux.',
    recommended_for: ['flux'],
  },

  // ── Flux VAE ────────────────────────────────────────────────────────────
  {
    id: 'flux-ae',
    name: 'Flux VAE (ae.safetensors)',
    category: 'vae',
    source: 'hf',
    url: 'https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors',
    target_subpath: 'vae/ae.safetensors',
    size_mb: 335,
    description: 'Autoencoder used by FLUX.1 (and Lumina-2 — same architecture).',
    recommended_for: ['flux'],
  },

  // ── Popular Flux LoRAs ──────────────────────────────────────────────────
  {
    id: 'flux-realism-lora',
    name: 'Flux Realism LoRA',
    category: 'loras',
    source: 'hf',
    url: 'https://huggingface.co/XLabs-AI/flux-lora-collection/resolve/main/realism_lora.safetensors',
    target_subpath: 'loras/realism_lora.safetensors',
    size_mb: 22,
    description: 'XLabs photo-realism style LoRA for Flux.',
    recommended_for: ['flux'],
  },
  {
    id: 'flux-anime-lora',
    name: 'Flux Anime LoRA',
    category: 'loras',
    source: 'hf',
    url: 'https://huggingface.co/XLabs-AI/flux-lora-collection/resolve/main/anime_lora.safetensors',
    target_subpath: 'loras/anime_lora.safetensors',
    size_mb: 22,
    description: 'XLabs anime style LoRA for Flux.',
    recommended_for: ['flux'],
  },
  {
    id: 'flux-art-lora',
    name: 'Flux Art LoRA',
    category: 'loras',
    source: 'hf',
    url: 'https://huggingface.co/XLabs-AI/flux-lora-collection/resolve/main/art_lora.safetensors',
    target_subpath: 'loras/art_lora.safetensors',
    size_mb: 22,
    description: 'XLabs painterly art style LoRA for Flux.',
    recommended_for: ['flux'],
  },
  {
    id: 'flux-disney-lora',
    name: 'Flux Disney LoRA',
    category: 'loras',
    source: 'hf',
    url: 'https://huggingface.co/XLabs-AI/flux-lora-collection/resolve/main/disney_lora.safetensors',
    target_subpath: 'loras/disney_lora.safetensors',
    size_mb: 22,
    description: 'XLabs Disney/Pixar-style LoRA for Flux.',
    recommended_for: ['flux'],
  },

  // ── SDXL base + VAE ─────────────────────────────────────────────────────
  {
    id: 'sdxl-base',
    name: 'SDXL Base 1.0',
    category: 'checkpoints',
    source: 'hf',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
    target_subpath: 'checkpoints/sd_xl_base_1.0.safetensors',
    size_mb: 6940,
    description: 'Stability AI SDXL base checkpoint.',
    license: 'CreativeML Open RAIL++-M',
    recommended_for: ['sdxl'],
  },
  {
    id: 'sdxl-refiner',
    name: 'SDXL Refiner 1.0',
    category: 'checkpoints',
    source: 'hf',
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-refiner-1.0/resolve/main/sd_xl_refiner_1.0.safetensors',
    target_subpath: 'checkpoints/sd_xl_refiner_1.0.safetensors',
    size_mb: 5870,
    description: 'SDXL refiner — optional second-pass image cleanup model.',
    license: 'CreativeML Open RAIL++-M',
    recommended_for: ['sdxl'],
  },
  {
    id: 'sdxl-vae',
    name: 'SDXL VAE (fp16 fix)',
    category: 'vae',
    source: 'hf',
    url: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors',
    target_subpath: 'vae/sdxl_vae.safetensors',
    size_mb: 320,
    description: 'FP16-safe SDXL VAE by madebyollin. Required for FP16 SDXL inference.',
    recommended_for: ['sdxl'],
  },

  // ── SD 1.5 stack ────────────────────────────────────────────────────────
  {
    id: 'sd15-base',
    name: 'SD 1.5 Base (pruned)',
    category: 'checkpoints',
    source: 'hf',
    url: 'https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
    target_subpath: 'checkpoints/v1-5-pruned-emaonly.safetensors',
    size_mb: 4270,
    description: 'Runway SD 1.5 base (EMA-only, pruned).',
    license: 'CreativeML Open RAIL-M',
    recommended_for: ['sd15'],
  },
  {
    id: 'sd15-vae-mse',
    name: 'SD 1.5 VAE (MSE)',
    category: 'vae',
    source: 'hf',
    url: 'https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors',
    target_subpath: 'vae/vae-ft-mse-840000-ema-pruned.safetensors',
    size_mb: 335,
    description: 'Stability AI MSE-tuned VAE for SD 1.5 — improved color & detail.',
    recommended_for: ['sd15'],
  },

  // ── ControlNet (SDXL) ───────────────────────────────────────────────────
  {
    id: 'controlnet-sdxl-canny',
    name: 'ControlNet SDXL — Canny',
    category: 'controlnet',
    source: 'hf',
    url: 'https://huggingface.co/diffusers/controlnet-canny-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors',
    target_subpath: 'controlnet/controlnet-canny-sdxl-1.0.safetensors',
    size_mb: 2500,
    description: 'Canny edge ControlNet for SDXL.',
    recommended_for: ['sdxl'],
  },
  {
    id: 'controlnet-sdxl-depth',
    name: 'ControlNet SDXL — Depth',
    category: 'controlnet',
    source: 'hf',
    url: 'https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors',
    target_subpath: 'controlnet/controlnet-depth-sdxl-1.0.safetensors',
    size_mb: 2500,
    description: 'Depth-map ControlNet for SDXL.',
    recommended_for: ['sdxl'],
  },

  // ── Upscalers ───────────────────────────────────────────────────────────
  {
    id: 'upscale-4x-ultrasharp',
    name: '4x-UltraSharp (upscaler)',
    category: 'upscale_models',
    source: 'hf',
    url: 'https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth',
    target_subpath: 'upscale_models/4x-UltraSharp.pth',
    size_mb: 64,
    description: 'Popular 4x ESRGAN upscaler — sharp, low-artifact.',
  },
  {
    id: 'upscale-real-esrgan-x4',
    name: 'Real-ESRGAN x4 plus',
    category: 'upscale_models',
    source: 'hf',
    url: 'https://huggingface.co/dtarnow/UPscaler/resolve/main/RealESRGAN_x4plus.pth',
    target_subpath: 'upscale_models/RealESRGAN_x4plus.pth',
    size_mb: 64,
    description: 'General-purpose 4x ESRGAN upscaler.',
  },
];

// Lookup by model filename — used by the workflow-aware auto-resolve
// path to match a "missing model" against a catalog entry.
export function findByFilename(filename: string): CatalogModel | undefined {
  const lower = filename.toLowerCase();
  return CATALOG.find(m => {
    const tail = m.target_subpath.split('/').pop()?.toLowerCase();
    return tail === lower;
  });
}

export function findById(id: string): CatalogModel | undefined {
  return CATALOG.find(m => m.id === id);
}

export function byCategory(category: ModelCategory): CatalogModel[] {
  return CATALOG.filter(m => m.category === category);
}
