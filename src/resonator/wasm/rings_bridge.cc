#include <algorithm>
#include <cstddef>
#include <cstdint>

#include "rings/dsp/dsp.h"
#include "rings/dsp/part.h"
#include "rings/dsp/patch.h"
#include "rings/dsp/performance_state.h"

namespace {

rings::Part part;
rings::Patch base_patch = {0.5f, 0.5f, 0.5f, 0.5f};
rings::Patch render_patch = {0.5f, 0.5f, 0.5f, 0.5f};
rings::PerformanceState performance = {
    false,
    true,
    false,
    false,
    48.0f,
    0.0f,
    0.0f,
    0,
};

uint16_t reverb_buffer[32768];
float frequency_mod = 0.0f;
float structure_mod = 0.0f;
float brightness_mod = 0.0f;
float damping_mod = 0.0f;
float position_mod = 0.0f;
float pending_note = 0.0f;
float pending_velocity = 0.0f;
bool pending_strum = false;
bool initialized = false;

float clamp01(float value) {
  return std::min(1.0f, std::max(0.0f, value));
}

float clamp_bipolar(float value) {
  return std::min(1.0f, std::max(-1.0f, value));
}

void ensure_initialized() {
  if (initialized) return;
  part.Init(reverb_buffer);
  part.set_polyphony(1);
  part.set_model(rings::RESONATOR_MODEL_MODAL);
  initialized = true;
}

}  // namespace

extern "C" {

void rings_init(float sample_rate) {
  (void)sample_rate;
  initialized = false;
  ensure_initialized();
}

void rings_set_patch(
  float frequency,
  float structure,
  float brightness,
  float damping,
  float position
) {
  ensure_initialized();
  performance.tonic = 18.0f + clamp01(frequency / 60.0f) * 60.0f;
  base_patch.structure = clamp01(structure);
  base_patch.brightness = clamp01(brightness);
  base_patch.damping = clamp01(damping);
  base_patch.position = clamp01(position);
  render_patch = base_patch;
}

void rings_set_mods(
  float frequency_cv,
  float structure_cv,
  float brightness_cv,
  float damping_cv,
  float position_cv
) {
  ensure_initialized();
  frequency_mod = clamp_bipolar(frequency_cv);
  structure_mod = clamp_bipolar(structure_cv);
  brightness_mod = clamp_bipolar(brightness_cv);
  damping_mod = clamp_bipolar(damping_cv);
  position_mod = clamp_bipolar(position_cv);
}

void rings_set_model(int model) {
  ensure_initialized();
  if (model < 0 || model >= rings::RESONATOR_MODEL_LAST) {
    model = rings::RESONATOR_MODEL_MODAL;
  }
  part.set_model(static_cast<rings::ResonatorModel>(model));
}

void rings_strum(float v_oct, float velocity, int trigger, float exciter) {
  ensure_initialized();
  const float cv = clamp01(exciter);
  performance.fm = frequency_mod * cv * 24.0f;
  render_patch.structure = clamp01(base_patch.structure + structure_mod * cv * 0.5f);
  render_patch.brightness = clamp01(base_patch.brightness + brightness_mod * cv * 0.5f);
  render_patch.damping = clamp01(base_patch.damping + damping_mod * cv * 0.5f);
  render_patch.position = clamp01(base_patch.position + position_mod * cv * 0.5f);
  pending_note = v_oct * 12.0f;
  pending_velocity = clamp01(velocity);
  pending_strum = trigger != 0;
}

void rings_process(const float* input, float* odd, float* even, int frames) {
  ensure_initialized();
  float in_block[rings::kMaxBlockSize];
  float odd_block[rings::kMaxBlockSize];
  float even_block[rings::kMaxBlockSize];

  int offset = 0;
  while (offset < frames) {
    const int block_size = std::min<int>(rings::kMaxBlockSize, frames - offset);
    for (int i = 0; i < block_size; ++i) {
      const float external = input ? input[offset + i] : 0.0f;
      in_block[i] = external + (pending_strum && i == 0 ? pending_velocity * 0.7f : 0.0f);
    }

    performance.note = pending_note;
    performance.strum = pending_strum;
    performance.internal_exciter = true;
    performance.internal_strum = pending_strum;
    performance.internal_note = false;

    part.Process(performance, render_patch, in_block, odd_block, even_block, block_size);
    for (int i = 0; i < block_size; ++i) {
      odd[offset + i] = odd_block[i];
      even[offset + i] = even_block[i];
    }

    pending_strum = false;
    offset += block_size;
  }
}

}
