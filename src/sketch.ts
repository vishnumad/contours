import './style.css';
import { initP5 } from './p5/init';

let noiseOffset = 0;

function setup() {
  const root = document.querySelector<HTMLDivElement>('#app');
  const canvas = createCanvas(windowWidth, windowHeight);

  canvas.parent(root!);
  pixelDensity(window.devicePixelRatio || 1);
  noFill();
  strokeWeight(1.5);
}

function draw() {
  background('#f3efe6');

  const bands = 18;
  const stepY = height / (bands + 1);

  for (let band = 0; band < bands; band += 1) {
    const y = stepY * (band + 1);
    const hue = 18 + band * 6;

    stroke(`hsla(${hue}, 48%, 31%, 0.8)`);
    beginShape();

    for (let x = -40; x <= width + 40; x += 16) {
      const wave = noise(x * 0.003, band * 0.16, noiseOffset) * 90;
      const curve = Math.sin(x * 0.012 + band * 0.55 + noiseOffset * 2.4) * 26;
      splineVertex(x, y + wave + curve - 70);
    }

    endShape();
  }

  noiseOffset += 0.003;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

initP5({ setup, draw, windowResized });
