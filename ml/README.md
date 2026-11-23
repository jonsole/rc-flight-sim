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
| `src/ml/policy.js` | The network: a small multi-layer perceptron (default 31 → 32 → 32 → 4, tanh, ~2200 weights) in plain JS. Saved as JSON. Browser-safe. |
| `src/ml/observe.js` | What the network sees (31 numbers, below). Browser-safe, so the game can feed a policy the same inputs. |
| `src/ml/guidance.js` | Where each skill is told to go: strip geometry, the take-off, landing and taxi target rules, aerobatic manoeuvres. Shared by training and the game. |
| `src/ml/rates.js` | Each model's roll, pitch and yaw rates at full stick (aerobatic commands are fractions of them). |
| `src/aircraft/defs.js` | Builds a model's flight definition from its JSON file without Vite (the registry in `index.js` uses it too). |
| `ml/env.js` | The environment: reset from a seed, step with stick positions, get observation + reward + done. Flat grass, gusty wind; the flying tasks. |
| `ml/tasks.js` | The take-off, landing, taxi and aerobatics tasks. |
| `ml/es.js` | Evolution Strategies optimiser. |
| `ml/evaluate.js`, `ml/worker.js` | Score candidates, in parallel over worker threads (one per CPU core). |
| `ml/train.js` | The training loop and command line. |
| `ml/eval.js` | Fly a saved policy on unseen flights, print a table, optionally write a per-step CSV trace. |
| `ml/export-policy.js` | Copy a trained policy into the game (`src/ml/policies/`). |
| `ml/fly-day.js` | Fly the game's AI flyers through a day at a real field (terrain, trees, wind) in Node, logging every phase change, landing and crash. |

### Observations (all in the aircraft's frame: x forward, y up, z right)

airspeed, angle of attack, sideslip · roll / yaw / pitch rates · which way is
up · height above ground, climb rate · unit vector to the target point and
its distance · height error, airspeed error · motor throttle, wing stall
fraction · the network's previous four outputs · on the ground or not,
ground speed, height in fine steps near the ground (for the flare) · the
runway's direction (take-off, landing, taxi) · commanded roll, pitch and yaw
rates (aerobatics).

New inputs are only ever added at the end. A policy file lists the inputs
it was trained on, so the first fly-to-point policies keep their 23
(`--inputs v1`). `--init` warm-starts from a policy with different inputs:
first-layer weights are matched up by name and new inputs start at zero, so
the new policy flies exactly like the old one until training uses them.

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
| `takeoff` | Standing at the start of a 60–180 m strip of anything from mown runway to rough grass (hand-launched models: in the hand), up the climb-out to 35 m. 25 s. | Distance along the strip (on the ground only to its end), height gained, +20 for climbing out; off the centreline, below the climb profile, slow or scraping a wing cost. Running out of strip ends it (−8). |
| `land` | 90–160 m out on a 7° approach (`--glide 7-13`: anything from 7° to 13°), up to 12 m off the centreline and 20° off its heading; touch down near the aim point and stop. 35 s. | Progress towards the aim point (not time: staying up doesn't pay), less for being off the centreline or below the glide path (most) or above it; at touchdown up to +10 for a gentle one, +5 near the aim point on the strip, −3 crabbed; bounces −2; +5 for stopping, motor off, on the centreline. |
| `taxi` | On the ground: to one point and on to a second 10–60 m away, at 2.5 m/s, and stop. 40 s. | Distance closed (potential, so circling doesn't pay), +3 / +5 for reaching / stopping; over 4 m/s, leaving the ground or scraping cost; over 7 m/s ends it (−5). |
| `aero` | 150–250 m up and fast: a random string of pulls, rolls (either way), barrel rolls, pushes and holds, as fractions of what the model can do (`src/ml/rates.js`). 12 s. | 1 per second, less smoothly (tanh) for each axis's rate error relative to the model's best; stalling and below 25 m cost. **Not yet learnt well** (below). |

The flying tasks: −(10 − height)/10 per second below 10 m, −0.5 per second
fully stalled, a small cost for moving the sticks about (smoothness), and −10
and the end of the flight for touching the ground, crashing or flying 2 km
away. All tasks: −10 or more for crashing.

**Watch for reward hacking.** The first take-off network learnt to race
along the grass for ever (paid per metre, nothing stopped it), and the first
landing reward would have paid for never landing. Training logs how many
validation flights really succeed (`valSuccessRate`) as well as the score:
a rising score with no successes means the reward is being gamed.

**Aerobatics are flown by a classic controller for now.** Trained on
`aero`, the AeroScout's network cut the rate error only ~3% from
hands-off. Started 70–100 m up, following the commands lost height that cost
more than tracking paid, and a speed penalty punished the speed manoeuvres
bleed, so it learnt to ignore the commands; fixed (150–250 m, no speed
penalty), the tracking reward was still too weak against the smoothness
cost for ES to find. A feed-forward + proportional rate controller
(`RateController` in `src/ml/rates.js`) cuts the rate error 60–70% on most
models, so the AI flyers use it unless a trained `aero` skill is exported.
It could be the teacher for a network (behaviour cloning) next.

Take-off and landing strips point into any wind over 3 m/s (within 30°) and
any way in lighter wind, as the AI flyers' strips do in the game; take-off
and landing train in wind up to 8 m/s, taxi and aerobatics 6. Fresh take-off
networks start with the throttle open: at half throttle a model can't start
rolling on grass, every variation sits still and training gets no signal.

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
| `--task` | `hold` | `hold`, `waypoints`, `recover`, `takeoff`, `land`, `taxi` or `aero`. |
| `--inputs` | `sim` | `sim` (all 23), `hardware` (20: no angle of attack, sideslip or stall), or a list of input names. |
| `--gens` | 150 | Generations. |
| `--pairs` | 24 | Mirrored pairs per generation (population = 2 × pairs). |
| `--episodes` | 4 | Flights per candidate per generation. |
| `--seconds` | task's own | Flight length (20 s for the flying tasks; take-off 25, landing 35, taxi 40, aerobatics 12). |
| `--hidden` | `32,32` | Hidden layer widths. |
| `--sigma` | 0.05 | Size of the random changes. |
| `--lr` | 0.03 | Adam step size. |
| `--l2` | 0.005 | Weight decay. |
| `--glide` | `7` | Landing approach angle in degrees, or a range (`7-13`). |
| `--wind` | task's own | Strongest mean wind (m/s): 4 for the flying tasks, 8 take-off and landing, 6 taxi and aerobatics. |
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

`node ml/export-policy.js ml/runs/<run>/best.json` copies a trained policy
to `src/ml/policies/`: a `hold` policy as `<aircraft id>.json` (needed for a
model to be an AI flyer at all), the others as `<aircraft id>.<task>.json`
(weights rounded to 5 significant figures, ~18 KB each).

In the game `src/ml/aiPilot.js` plans the flight and picks the skill:

- **With `takeoff` and `land`**: a day at the field. Parked in the pits on
  the far side of the strip from the pilots; taxi out (or, without `taxi`
  or hand-launched, carried out) once the runway is free; take off; a
  circuit on the far side (crosswind, downwind, base); final, following the
  centreline 2 m above the glide path, hands over to the landing skill about
  110 m out; land (or a low pass and round again); taxi back to the pits (or
  be carried back); and again. On the downwind leg, now and then, an
  aerobatic manoeuvre (`aero`) higher and further out: loop, rolls,
  Immelmann, split S, Cuban eight, barrel roll, inverted pass (no rolls for
  rudder-only models). Going around: off the centreline, low on the
  approach, long, or you on the strip. One AI on the runway at a time.
- Every flight lands before the battery is flat: below 35% charge no more
  aerobatics or extra laps, in on the next circuit (where the take-off strip
  has trees on its approaches, on the landing strip found for that).
  Low passes come down the glide path to 3.5 m along the strip (belly-
  landers 20 m) and climb away. AI flyers take off from their own lane, 5 m
  beside the runway, so your plane sitting on it doesn't hold them up.
- **With only `hold`** (no take-off and landing): not offered as an AI
  flyer, since it couldn't land before its battery went flat (the S.E.5a
  and Mini F-22 for now).

In wind over 70% of a model's cruise speed it doesn't fly circuits (a light
model hardly moves into wind on final, sinks below the glide path and can't
climb away), it just flies round.

Which models have which skills (`src/ml/policies/`):

| Model | Fly | Take-off | Landing | Taxi | |
| --- | --- | --- | --- | --- | --- |
| HobbyZone AeroScout | ✓ | ✓ | ✓ | ✓ | full day |
| Buschtrottel ShockCub | ✓ | ✓ | ✓ | (trained, not used) | circuits, carried out and back |
| Buschtrottel Highlander | ✓ | ✓ | ✓ (from the ShockCub's) | (trained, not used) | circuits, carried |
| Buschtrottel Agro | ✓ | ✓ | ✓ | (trained, not used) | circuits, carried |
| Multiplex EasyStar | ✓ | ✓ hand launch | ✓ belly | n/a | circuits, picked up |
| E-flite S.E.5a | ✓ | ✓ | ✗ | | takes off, then flies round: at idle the draggy biplane bleeds to its stall in ~2 s; every landing network so far dived in or struck its prop |
| FT Mighty Mini F-22 | ✓ | ✓ hand launch | ✗ | n/a | launched, then flies round: glides flat at 13 m/s and its landing network learnt only to overshoot |

The Buschtrottels' taxi networks pass their own task (26-30/30), but taxiing
out at the real fields then lining up and rolling cost prop strikes on the
take-off roll (11 crashes in 31 flights, against 3 in 48 carried), so they
aren't exported yet: the take-off skill trained from a standstill, not
from a taxi.

Training these taught a lot about rewards: every landing reward had a
loophole somewhere (hover at 8 m, land gently 100 m short, crash at once
rather than collect small costs, overshoot rather than risk the flare). The
rule that held: crashing < touching down off the strip < not landing <
landing, with the steering costs small enough never to change that order.

Where they take off and land is chosen by `src/ml/fieldStrip.js` for the
wind: the runway from its upwind end in a light wind (≤ 3 m/s) or one along
it, else a 90 m (down to 60 m at a small field) strip straight into the wind
(or up to 30° off it) across the field, centred within 50 m of the pilots (not
behind them; 90 m for a battery landing if nothing nearer is clear). Every strip's whole flight path is checked clear of trees,
buildings, fences and the pilots, first with a 7° approach and then steeper
(9°, 11°, 13°) over the trees short of it: at Barrack Field an east or west
wind takes 11°. If nowhere is clear, they take off near the pilots and land
on the take-off strip anyway when the battery runs low.

`node ml/fly-day.js --aircraft <id> --field <home|waterbeach|impington>
--wind 6 --windDir 225 --minutes 10` flies it all in Node and logs every
phase. `tests/ai-flyers.test.js` flies every exported policy round the club
field, and every model with take-off and landing through a 10-minute day,
and fails on a crash.

## Evaluating

`ml/eval.js --policy <file>` flies 20 unseen flights (seeds from 5 000 000)
on the aircraft and task the policy was trained for and prints height,
heading and speed errors, crashes and waypoints. `--trace out.csv` writes
every step of the first flight (position, attitude, target, sticks, reward
and all the observations) for plotting. `--aircraft`, `--task`, `--seconds`,
`--wind` and `--episodes` override.
