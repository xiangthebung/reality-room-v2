import { cavesNear, heightAt, setWorldSeed } from '../src/world/terrain.js';

/** TEMPORARY. What slope is the ground actually at, and what does the litter fade do there. */
setWorldSeed(process.argv[2] ?? 'grove-01');

const H = 0.8; // half the terrain grid pitch: the scale a mesh normal sees
const up = (x, z) => {
  const dx = (heightAt(x + H, z) - heightAt(x - H, z)) / (2 * H);
  const dz = (heightAt(x, z + H) - heightAt(x, z - H)) / (2 * H);
  return 1 / Math.sqrt(1 + dx * dx + dz * dz);
};
const ss = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const OLD = (u) => 1.18 * (1 - 0.75 * ss(0.93, 0.7, u));
const NEW = (u) => 1.18 * (1 - 0.9 * ss(0.93, 0.62, u));

function census(label, cx, cz, r) {
  const ups = [];
  const N = 121;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = cx + ((i / (N - 1)) * 2 - 1) * r;
      const z = cz + ((j / (N - 1)) * 2 - 1) * r;
      ups.push(up(x, z));
    }
  }
  ups.sort((a, b) => a - b);
  const q = (p) => ups[Math.min(ups.length - 1, Math.round(p * (ups.length - 1)))];
  const deg = (u) => ((Math.acos(Math.min(1, u)) * 180) / Math.PI).toFixed(1);
  const mean = (f) => ups.reduce((s, u) => s + f(u), 0) / ups.length;
  console.log(
    `${label.padEnd(22)} r=${r}m  slope p10/p50/p90 = ${deg(q(0.9))}/${deg(q(0.5))}/${deg(q(0.1))} deg` +
      `   litter old ${mean(OLD).toFixed(3)} -> new ${mean(NEW).toFixed(3)}` +
      `   steepest ${deg(q(0.0))} deg: old ${OLD(q(0.0)).toFixed(3)} new ${NEW(q(0.0)).toFixed(3)}`
  );
}

census('spawn clearing', 0, 0, 25);
census('open wood', -34, -46, 40);
const c = cavesNear(0, 0, 900)[0];
census(`crag mouth k=${c.k}`, c.x, c.z, 22);
census(`crag surrounds k=${c.k}`, c.x, c.z, 60);
