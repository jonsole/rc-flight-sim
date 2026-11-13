# RC Flight Sim

A browser-based radio-control aeroplane simulator with **line-of-sight** and
**FPV** views. The first model is a 1/5 scale electric **Royal Aircraft
Factory S.E.5a** WWI biplane.

It runs in any modern browser (Chrome or Edge recommended on Windows). There is
nothing to install for flying: the build is a static website.

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
R = reset, C = camera, P = pause, H = HUD, M = mute, Esc = menu.

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

The S.E.5a numbers (`src/sim/se5a.js`) are a 1/5 scale model: 1.62 m span,
0.9 m² wing area, 2.2 kg, about 0.8:1 static thrust to weight.

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
