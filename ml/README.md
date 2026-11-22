# Neural-network pilots

A harness for training a small neural network to fly the sim's models. It
runs the game's own flight model (`src/sim/aircraft.js`) under Node, with no
browser and no graphics, so a policy learnt here sees exactly the physics it
will meet in the game.

```bash
npm install
npm run train -- --aircraft hobbyzone-aeroscout --task hold --gens 150
npm run train:eval -- --policy ml/runs/hold-hobbyzone-aeroscout/best.json
npm run train:eval -- --policy none --task hold      # hands-off baseline to compare with
```

## How it fits together

| File | What it does |
| --- | --- |
| `src/ml/policy.js` | The network: a small multi-layer perceptron (default 23 → 32 → 32 → 4, tanh, ~2000 weights) in plain JS. Saved as JSON. Browser-safe. |
| `src/ml/observe.js` | What the network sees (23 numbers, below). Browser-safe, so the game can feed a policy the same inputs. |
| `src/aircraft/defs.js` | Builds a model's flight definition from its JSON file without Vite (the registry in `index.js` uses it too). |
| `ml/env.js` | The environment: reset from a seed, step with stick positions, get observation + reward + done. Flat grass, gusty wind, three tasks. |
| `ml/es.js` | Evolution Strategies optimiser. |
| `ml/evaluate.js`, `ml/worker.js` | Score candidates, in parallel over worker threads (one per CPU core). |
| `ml/train.js` | The training loop and command line. |
| `ml/eval.js` | Fly a saved policy on unseen flights, print a table, optionally write a per-step CSV trace. |

### Observations (all in the aircraft's frame: x forward, y up, z right)

airspeed, angle of attack, sideslip · roll / yaw / pitch rates · which way is
up · height above ground, climb rate · unit vector to the target point and
its distance · height error, airspeed error · motor throttle, wing stall
fraction · the network's previous four outputs.

`--inputs hardware` trains on only what a real flight controller can
measure (20 inputs): it leaves out angle of attack and sideslip (they need
vanes or a multi-hole probe) and the wing stall fraction (no sensor gives
it). The rest map onto gyro (rates), attitude estimate (up), pitot
(airspeed), baro/GPS (height, climb) and GPS (target). `--inputs` also takes
a comma-separated list of the names in `OBS_NAMES`. A policy file records
its inputs (`meta.inputs`), and `ml/eval.js` feeds it those.

The target is always "a point to fly at, and an airspeed": holding a heading
and height is a point 150 m ahead along that heading at that height;
following waypoints is the next waypoint. So one network shape covers every
task, and a hold policy can be used as the starting point for waypoints
(`--init`).

### Actions

Roll, pitch, yaw sticks (-1..1) and throttle (0..1), sent straight to the
servos with flight assist off (no AS3X / SAFE), 50 times a second. On the
EasyStar the roll stick works the rudder, as in the game.

### Tasks and rewards

| Task | Episode | Reward |
| --- | --- | --- |
| `hold` | Start in level-ish flight at 30–60 m; fly a commanded heading, height (25–70 m) and airspeed. A new command every 6–14 s (turns of up to ±120°). | Per second: 1, less up to 0.4 for height error (full at 15 m), 0.4 for heading error (full at 90°), 0.2 for speed error (full at 4 m/s). Max ≈ episode length. |
| `waypoints` | Fly through a chain of points 60–140 m apart at 20–70 m, turning up to ±150° between them; reached within 10 m. | Distance closed on the current waypoint (≈1 per second at cruise), +5 per waypoint. |
| `recover` | Start upset: any bank (inverted too), ±45° pitch, 50–130% of cruise speed, spinning; then hold heading and height. | As `hold`. |

All tasks: −(10 − height)/10 per second below 10 m, −0.5 per second fully
stalled, a small cost for moving the sticks about (smoothness), and −10 and
the end of the flight for touching the ground, crashing or flying 2 km away.

Every flight is randomised from its seed: wind 0–4 m/s from any direction
with gusts that differ across the span, weight and inertia ±10%, start
height, speed, heading and attitude. Same seed, same flight, exactly.

## Why Evolution Strategies

ES (Salimans et al., 2017) perturbs all the weights at random, flies each
perturbed network, and moves the weights towards the better ones. For this
problem it is a good first choice:

- **No gradients needed** through the flight model, which has crashes, ground
  contact, stall hysteresis and clamps; it treats the sim as a black box.
- **Embarrassingly parallel**: each candidate flies on its own; the harness
  uses every CPU core with no extra dependencies (no Python, no PyTorch).
- **Small networks** (a few thousand weights) are exactly where ES works well,
  and small networks are cheap enough to run in the browser at 50 Hz.
- **Common random numbers**: every candidate in a generation flies the same
  seeds, so differences in score come from the weights, not the weather.

Specifics: mirrored sampling, centred-rank fitness shaping, Adam, weight
decay. A fresh set of training flights every generation; a fixed set of
validation flights, never trained on, picks `best.json`.

If ES plateaus, the next step would be PPO or SAC (gradient-based RL); the
environment already has the reset/step interface those need, and could be
wrapped for Python over a pipe.

## Training options

| Option | Default | |
| --- | --- | --- |
| `--aircraft` | `hobbyzone-aeroscout` | Model id, comma-separated list, or `all` (one policy for several models; flights rotate between them). |
| `--task` | `hold` | `hold`, `waypoints` or `recover`. |
| `--inputs` | `sim` | `sim` (all 23), `hardware` (20: no angle of attack, sideslip or stall), or a list of input names. |
| `--gens` | 150 | Generations. |
| `--pairs` | 24 | Mirrored pairs per generation (population = 2 × pairs). |
| `--episodes` | 4 | Flights per candidate per generation. |
| `--seconds` | 20 | Flight length. |
| `--hidden` | `32,32` | Hidden layer widths. |
| `--sigma` | 0.05 | Size of the random changes. |
| `--lr` | 0.03 | Adam step size. |
| `--l2` | 0.005 | Weight decay. |
| `--wind` | 4 | Strongest mean wind (m/s); 0 for calm air. |
| `--control-hz` | 50 | Stick updates per second. |
| `--substep` | 1/600 | Physics step (the game's). Bigger is faster and less exact. |
| `--eval-every` | 5 | Generations between validation runs. |
| `--eval-episodes` | 16 | Validation flights. |
| `--workers` | CPU cores | Worker threads. |
| `--seed` | 1 | |
| `--name` | `<task>-<aircraft>` | Run folder name under `ml/runs/`. |
| `--init` | | Start from this policy file (same network shape). |
| `--resume` | | Carry on a run from its `latest.json`. |

Each run writes `ml/runs/<name>/` (ignored by git): `config.json`,
`log.csv` (generation, wall time, population mean and max, validation score
and crash rate, step size), `best.json` and `latest.json`.

Speed: the flight model takes 4–15 µs per physics step depending on the
model, so a 20 s flight is roughly 50–200 ms. With the defaults (48
candidates × 4 flights) a generation takes about 6 s on 4 cores.

## Using a policy in the game

`node ml/export-policy.js ml/runs/<run>/best.json` copies a trained `hold`
policy to `src/ml/policies/<aircraft id>.json` (weights rounded to 5
significant figures, ~17 KB), which makes that model available as an AI
flyer (*Menu → Flying → AI flyers*). In the game `src/ml/aiPilot.js` gives
the policy a point 150 m along the way to its next waypoint, at the
waypoint's height above the ground (never below 30 m over the ground under
or just ahead of it): the same kind of target it trained on, now over the
real field with its hills, trees and wind. `tests/ai-flyers.test.js` flies
every exported policy round the club field for two minutes and fails if it
crashes.

## Evaluating

`ml/eval.js --policy <file>` flies 20 unseen flights (seeds from 5 000 000)
on the aircraft and task the policy was trained for and prints height,
heading and speed errors, crashes and waypoints. `--trace out.csv` writes
every step of the first flight (position, attitude, target, sticks, reward
and all the observations) for plotting. `--aircraft`, `--task`, `--seconds`,
`--wind` and `--episodes` override.
