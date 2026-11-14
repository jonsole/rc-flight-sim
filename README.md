# RC Flight Sim

A browser-based radio-control aeroplane simulator with **line-of-sight** and
**FPV** views. Pick your aircraft on the start screen or in the menu:

| Aircraft | Notes |
| --- | --- |
| **E-flite S.E.5a 900mm** (EFL10950 / EFL10975) | Foam BNF WWI biplane with AS3X+/SAFE. |
| **Buschtrottel ShockCub** | Thomas Buchwald's DIY 6 mm Depron bush plane, 900 mm: high wing, rounded tail. |
| **Buschtrottel Highlander** | Same airframe with an angular tail and square wing tips. |
| **Buschtrottel Agro** | Low wing with V-struts to the upper fuselage, full-span ailerons, black canopy block, low tailplane; orange and white; 8x4.5 three-blade prop. |
| **Flite Test Mighty Mini F-22** | Foam-board pusher jet, 508 mm: the prop spins in a slot in the middle of the diamond wing; elevons, canted fins, no rudder or wheels. Hand-launched. |

The Buschtrottels are set up as built here: AT2308 1450Kv,
3S 1350 mAh with an 8x6 prop (Agro: 8x4.5 three-blade), ~450 g, KFm2 wing,
100 mm foam wheels on springy wire legs,
and a rudder-linked tail wheel.
Plan figures: ~900 mm span, ~22 dm² wing (19.8 g/dm² published loading).

The Mini F-22 (`src/aircraft/f22.js`) is traced off the FT plan sheets: 508 mm
span, 667 mm long, 14.2 dm², 211 g all up, 3S 800 mAh. This one has a 2204
2600Kv with a 5x4.5 five-blade prop (the plan's 2300Kv and 6x4.5 is slower). The flat wing makes lift only from its angle
of attack, so the elevons are trimmed with the plan's 8° of reflex, and the CG
is at the plan's marks on the wing. The fuselage follows a printed front
section (F22_Fuselage_FRONT_Rev03): a nose fairing ahead of the wing that runs
into the canopy, and a 41 mm box hanging under the wing. Elevons: 25° each way. Hands-off it
flies level at a bit over half throttle (~50 km/h); it climbs with more.
At the stall the elevons sit in the wing's dead air and lose most of their
bite, and it falls off on the left wing. Thrust and inertia are estimates.
There is no landing gear: with *Start position: On the runway* the pilot holds
it at the flight line (your pilot position) and throws it once the throttle
passes 60%. Land it on its belly (the belly pan and side plates under the
wing) with the motor off, since the prop hangs below the wing.

It runs in any modern browser (Chrome or Edge recommended on Windows). There is
nothing to install for flying: the build is a static website.

**Play online:** https://jonsole.github.io/rc-flight-sim/

## Quick start

```bash
npm install
npm run dev        # open the printed http://localhost:5173 link
```

To produce a static build you can open from any web server:

```bash
npm run build      # output in dist/
npm run preview
```

## Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes one Pages site with two channels:

| URL | Branch |
| --- | --- |
| https://jonsole.github.io/rc-flight-sim/ | `main` (live) |
| https://jonsole.github.io/rc-flight-sim/dev/ | development branch (badged "DEV") |

A push to either branch tests, builds and republishes both. If the dev build
fails, the live site is still published. One-time setup: **Settings → Pages →
Source: GitHub Actions**, and allow both branches under **Settings →
Environments → github-pages → Deployment branches**.

Releasing: merge the dev branch into `main` with a merge commit
(`git merge --no-ff`). Pages ignores a second deployment of a commit it has
already deployed, so fast-forwarding `main` to a commit the dev branch already
published leaves the live page on the older build.

## Flying with your transmitter

Most transmitters can act as a USB game controller:

- **EdgeTX / OpenTX** (Radiomaster, Jumper, FrSky…): plug in USB and choose
  *USB Joystick (HID)*.
- **Spektrum / others**: use the transmitter's USB sim mode, or a USB sim dongle.

Then press **Esc → Transmitter**, move a stick so the browser sees the device,
and use **Detect** on each channel (move only that stick). Check the direction
bars, tick *Reverse* where needed, and run **Calibrate sticks**. Switches can
be assigned to *reset* and *change camera*. Settings are saved in the browser.

Keyboard fallback: arrows = aileron/elevator, A/D = rudder, W/S = throttle,
R = reset, C = camera, G = flight assist, P = pause, H = HUD, M = mute, Esc = menu.

## Phones and tablets

On a touch screen the sim shows two on-screen sticks (Mode 2 by default:
throttle and rudder on the left, elevator and ailerons on the right; the
throttle stays where you leave it, the others spring back) and buttons for
camera, reset, flight assist and the menu. Turn the phone sideways. Stick mode
and showing or hiding the sticks are under **Menu → Transmitter**; a connected
transmitter or gamepad still takes priority.

## Views

| View | What it is |
| --- | --- |
| Line of sight | You stand at the flight line, 1.7 m eye height, and track the model. Optional auto-zoom keeps it visible at range. Pilot position is adjustable. |
| FPV | From the pilot's seat (looking past the Vickers gun, cabane struts and radiator) or a top-wing camera pod. Adjustable uptilt and FOV, an INAV-style OSD (battery, mAh, speed, altitude, home arrow, timer), motor vibration and an optional analog-video effect. |
| Chase | A follow camera, handy while learning. |

## Flight model

`src/sim/` is a rigid-body model built from individual lifting surfaces: each
wing is split into spanwise panels, plus tailplane, fin and fuselage. Every
panel sees its own local airflow (body rotation, prop wash and wing downwash),
with lift and drag curves that stall and become flat-plate past the stall.
Stability, damping, adverse yaw, dihedral effect, wing drop at the stall and
the tail-dragger ground handling come out of that rather than being scripted.
Also modelled: ground surfaces (mown runway, field grass, rough ground and the
gravel pad, each with its own rolling resistance, stiction and bumps),
collisions with trees, the club hut, the windsock pole, the
fence and the table (solid objects push back and crash the model on a hard
hit; foliage is soft and catches a slow model in the branches),
ground effect (within about a wingspan of the ground: less
induced drag, more lift, less downwash at the tail), electric motor thrust
fall-off with airspeed, torque reaction,
a LiPo battery with voltage sag, wind with a boundary-layer gradient and gusts,
spring/damper landing gear with wheel and skid friction, and crash detection.

The E-flite numbers (`src/aircraft/se5a.js`) follow E-flite's published specs:
899 mm span, 716 mm length, 1303 g with a 4S 2200 mAh pack, 3513-1100Kv motor
with a 10x5 prop, and the CG at 72 mm behind the top-wing leading edge. Wing
area (~0.28 m²), inertia, drag and the thrust curve are not published and are
estimated (about 1.25:1 static thrust to weight on 4S).

Flight assist mimics the BNF receiver: **AS3X** (rate-gyro damping, gains
scaled with airspeed) and **SAFE** (self-levelling with bank and pitch
limits). Switch with G or an assigned transmitter switch.

```bash
npm test           # flight-model checks: stability, trim, stall, controls, takeoff, crash
```

## Project layout

```
src/sim/       physics (no rendering): aero.js, aircraft.js, obstacles.js, terrain.js, wind.js
src/aircraft/  aircraft registry (index.js) and models: definitions + procedural 3D
src/world/     sky, terrain, runway, trees, windsock
src/view/      camera rig (LOS / FPV / chase)
src/input/     transmitter (Gamepad API) + keyboard, expo & rates
src/ui/        OSD/HUD, settings panel
src/audio/     synthesised motor and prop sound
tests/         vitest flight-model tests
```

## Adding an aircraft

Each aircraft is a registry entry in `src/aircraft/index.js`:

```js
{ id, name, summary, defaultAssist, def, geometry, views, createModel }
```

- `def`: the flight model (mass, inertia, lifting surfaces, contact points,
  motor, battery, trim, assist gains), as consumed by `src/sim/aircraft.js`.
- `views`: camera mounts in body axes (`cockpit`, `pod`), `span` for LOS
  auto-zoom, and `chase` distances.
- `createModel()`: returns `{ root, update(aircraft, dt), setPilotVisible(bool) }`.
- `def.handLaunch` (optional): `{ height, speed, pitch, throttle }` for a model
  with no wheels. It starts in the pilot's hand and is thrown along its nose
  once the throttle reaches `throttle`. The wheel tests are skipped for it.
- `def.cruiseThrottle` (optional, default 0.5): the throttle the trim test
  flies at, for an overpowered model that climbs at half throttle.

Another size of S.E.5a is one `buildSE5a({...})` call in `src/aircraft/se5a.js`.
A different type needs its own definition and 3D model module. The flight
tests run automatically for every registered aircraft.

## Multiplayer

Players who join the same room code see each other's aeroplanes (menu → Multiplayer, or share an invite link `…/?room=CODE`). Each browser flies its own aeroplane and sends its state about 15 times a second through a small relay server, `server/relay.js` (Node + `ws`). Everything goes over secure WebSocket on port 443, so it works behind NAT and firewalls; no peer-to-peer connections are made.

- Hosting: Render's free tier, set up from `render.yaml` with one click: <https://render.com/deploy?repo=https://github.com/jonsole/rc-flight-sim>. It sleeps after 15 minutes without players; the game wakes it when someone connects (up to a minute).
- Local relay: `cd server && npm install && npm start`, then set Server to `ws://127.0.0.1:8787` in the Multiplayer menu.
- The game connects to `wss://rc-flight-sim-relay.onrender.com` (`src/net/config.js`, or build with `VITE_MP_SERVER`).
