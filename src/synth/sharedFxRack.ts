import * as Tone from "tone";
import { BigSky, DEFAULT_BIGSKY, type BigSkyParams } from "./bigSky";
import { Deco, DEFAULT_DECO, type DecoParams } from "./deco";
import { DEFAULT_KLON, Klon, type KlonParams } from "./klon";
import { DEFAULT_ELCAP, ElCapistan, type ElCapParams } from "./tapeEcho";

export interface SharedFxParams {
  klon: KlonParams;
  deco: DecoParams;
  elcap: ElCapParams;
  bigSky: BigSkyParams;
}

export const DEFAULT_SHARED_FX: SharedFxParams = {
  klon: { ...DEFAULT_KLON },
  deco: { ...DEFAULT_DECO },
  elcap: { ...DEFAULT_ELCAP, time: 320 },
  bigSky: { ...DEFAULT_BIGSKY, size: 60, mix: 34 },
};

export class SharedFxRack {
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;

  private klon: Klon;
  private deco: Deco;
  private echo: ElCapistan;
  private bigSky: BigSky;

  constructor(destination: Tone.ToneAudioNode, defaults: SharedFxParams = DEFAULT_SHARED_FX) {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1).connect(destination);

    this.klon = new Klon();
    this.deco = new Deco();
    this.echo = new ElCapistan();
    this.bigSky = new BigSky();

    this.input.connect(this.klon.input);
    this.klon.output.connect(this.deco.input);
    this.deco.output.connect(this.echo.input);
    this.echo.output.connect(this.bigSky.input);
    this.bigSky.output.connect(this.output);

    this.applyAll(defaults);
  }

  setKlon(next: KlonParams): void {
    this.klon.applyParams(next);
  }

  setDeco(next: DecoParams): void {
    this.deco.applyParams(next);
  }

  setEcho(next: ElCapParams): void {
    this.echo.applyParams(next);
  }

  setBigSky(next: BigSkyParams): void {
    this.bigSky.applyParams(next);
  }

  applyAll(params: SharedFxParams): void {
    this.setKlon(params.klon);
    this.setDeco(params.deco);
    this.setEcho(params.elcap);
    this.setBigSky(params.bigSky);
  }

  pulse(amount: number): void {
    this.echo.pulse(amount);
    this.bigSky.pulse(amount);
  }

  dispose(): void {
    this.klon.dispose();
    this.deco.dispose();
    this.echo.dispose();
    this.bigSky.dispose();
    this.input.dispose();
    this.output.dispose();
  }
}
