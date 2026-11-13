# RC Flight Sim

A browser-based radio-control aeroplane simulator with **line-of-sight** and
**FPV** views. The first model is the **E-flite S.E.5a 900mm** (EFL10950 /
EFL10975), a foam park-flyer of the WWI Royal Aircraft Factory biplane.

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

`.github/workflows/pages.yml` tests, builds and deploys the site on every push
to `main`. One-time setup: in the repository go to **Settings → Pages** and set
**Source** to **GitHub Actions**.

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
Also modelled: electric motor thrust fall-off with airspeed, torque reaction,
a LiPo battery with voltage sag, wind with a boundary-layer gradient and gusts,
spring/damper landing gear with wheel and skid friction, and crash detection.

The aircraft numbers (`src/sim/se5a.js`) follow E-flite's published specs:
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
src/sim/       physics (no rendering): aero.js, aircraft.js, se5a.js, terrain.js, wind.js
src/models/    procedural 3D model of the S.E.5a
src/world/     sky, terrain, runway, trees, windsock
src/view/      camera rig (LOS / FPV / chase)
src/input/     transmitter (Gamepad API) + keyboard, expo & rates
src/ui/        OSD/HUD, settings panel
src/audio/     synthesised motor and prop sound
tests/         vitest flight-model tests
```

Adding another aircraft means a new definition next to `se5a.js` (mass,
inertia, surfaces, contacts, motor) and a 3D model.
