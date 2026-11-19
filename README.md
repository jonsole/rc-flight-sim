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
| **HobbyZone AeroScout S 2 1.1m** | Foam beginner trainer for club training: high wing with dihedral, pusher prop behind the cabin, tricycle gear with the nose wheel on the rudder. Starts in SAFE. |
| **Multiplex EasyStar** | Elapor foam powered glider, 1.37 m: long high wing with curved-up tips, pusher Permax 400 behind the wing, rudder and elevator only (the roll stick works the rudder). Hand-launched, belly-landed. |

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

The EasyStar (`src/aircraft/easystar.js`) is the original Multiplex one:
1370 mm span, 24 dm² wing, ~680 g, Permax 400 on 7-cell NiMH (8.4 V, modelled
as a 2S pack) with a 5x4 pusher prop. Its wing, tail and prop positions are
measured off the Blender model (`multiplex-easystar.glb`, origin at the CG).
It has no ailerons: the roll stick and the rudder stick both work the rudder,
and the curved-up wing tips turn yaw into bank. No gyro on the real one, so it
starts with assist off. Thrust, rpm, drag and inertia are estimates, set so it
trims at about 8 m/s at half throttle, climbs at about 1.7 m/s at full power,
and glides at about 9:1.

The AeroScout (`src/aircraft/aeroscout.js`) is set up for club beginners. It
starts with SAFE on (bank and pitch limited, wings level themselves when
the sticks are let go); G switches to AS3X or off, like the real model's
Beginner / Experienced modes. Published figures used: ~1095 mm span, ~870 mm
long, 2306 2250Kv on 3S 2200 mAh, CG 75 mm behind the wing's leading edge at
the root. The planform (~20 dm²), the prop (6x4 assumed), thrust, weight
(~850 g) and drag are estimates, set so it flies level at about 55% throttle
(~11 m/s) and climbs at full power (about 1.1:1 thrust to weight), as the
manual describes, stalls gently at about 7 m/s, and loops from level flight
at full power (with SAFE off or on AS3X: SAFE's pitch limit stops a loop). With SAFE off it
doesn't level itself: a bank stays where you leave it, and the rudder turns
it mostly flat. It sits level on its wheels, steers on the ground with the
rudder (nose wheel), and takes off hands-off at full power. Its prop has square
(bullnose) tips, drawn that way, and like the real one it is loud: square tips
buzz harder and harsher than tapered ones, and the pusher prop chops through
the wing's wake for a rasping note (*Blade tips* in the Tuning tab's
Propeller group changes it on any model; the sound is made in `src/audio/engine.js`). The 3D model,
`src/aircraft/models/hobbyzone-aeroscout.glb`, was made in Blender: textured
in the real one's printed scheme, with a removable black canopy (it comes off
in a crash). Edit it in Blender as below. The manual says
to use 70% low rates when learning: set the rates to 0.7 under
*Menu → Transmitter → Expo & rates*.

It runs in any modern browser (Chrome or Edge recommended on Windows). There is
nothing to install for flying: the build is a static website.

On a desktop, the start screen shows the selected aircraft turning slowly
(`src/ui/preview.js`); phones, tablets and small windows leave it out for room.

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

## Tuning the aircraft

*Menu → Tuning* shows the flight settings of the model you're flying, with
its defaults: all-up weight and CG position; static thrust, prop pitch
speed (top speed), motor torque, down- and right-thrust; the propeller
(diameter, pitch, blades, tapered or square tips: shown on the 3D model too;
square tips are much louder), the electric motor
(Kv, winding resistance) and the battery (cells, capacity, internal
resistance): the full-throttle rpm, current, thrust and top speed are
worked out from them, a bigger pack weighs more, and thrust fades as the
battery drains; the layout (thrust
line height and tailplane height relative to the wing, tail arm, tailplane
incidence); wing and tail drag, body drag; aileron, elevator and rudder throws; effective dihedral.
Changes apply when you let go of a slider, in flight too, and are saved in
your browser per model (↺ puts one back, *Reset all* the lot). *Export*
saves them to a file (send it in to have them built into the model) and
*Import* loads one.

## Flying fields

Pick the field on the start screen or under *Menu → Flying → Flying field*
(changing it reloads the page; `?field=waterbeach` in the URL opens Barrack Field):

| Field | Notes |
| --- | --- |
| **Club field** | Made up: a mown field in rolling country. |
| **Barrack Field** | The real field at Waterbeach, Cambridgeshire: the cricket pitch is the runway, with the grass mown about 32 m round it, and you stand 10 m south of it. 2 × 2 km of scenery around it is built from Environment Agency 1 m LIDAR (ground, ~5000 trees at their measured heights and crown sizes, hedges, building heights) and OpenStreetMap (building outlines, roads, paths, water, gardens, farmland), touched up from what's there now: bigger trees, the chain-link and temporary fences, demolished buildings left out. |
| **Hotel Glocknerhof** | The hotel's model airfield at Berg im Drautal, Carinthia (Austria), in the Drau valley under the hotel: a 200 m mown grass runway running roughly north-south between the access road and a maize field, the pits behind a 5 m safety net, the big green and white pyramid tent, cars along the road. You stand at the net near the north end, facing east. 2 × 2 km round it from the BEV's 1 m laser-scan heights (ground, ~5000 trees, conifers told from broadleaves by how dark they are from above, building heights), coloured from basemap.at aerial photos, with OpenStreetMap building outlines; and 14 × 14 km of the mountains round the valley (up to ~2500 m) from the same heights every 32 m, coloured from the aerial photos. `?field=glocknerhof`. |

Real fields are baked by `tools/bake_location.py` into `src/locations/<id>.json`
(about 2.6 MB), so nothing is fetched at run time and no API key is needed:

```bash
pip install numpy scipy pyproj tifffile pillow imagecodecs
python3 tools/bake_location.py waterbeach --cache /tmp/waterbeach-data
```

To add a field in England, add it to `SITES` in the script (the OSGB
easting/northing where the pilot stands) and its layout (runway and its
heading, mown areas, pilot box, fences, trees grown since the survey) to
`src/sim/location.js`.

Austrian fields (`source: 'bev'`, `tools/bev.py`) take the pilot's
latitude and longitude instead, and read the BEV's ALS DTM and DSM (CC BY 4.0)
straight from its 6 GB files over HTTP, only the parts they need (a few
hundred MB the first time, kept in the cache folder). They are laid out in a
local frame with true north up. With `far_half` and `far_cell` they also bake
the mountains round about (`far`, `farGround`), which the terrain then covers
instead of fading into made-up country. Players in multiplayer only meet others at the same
field.

### Scenery editor

Press **E** (or *Menu → Flying → Edit scenery*) to fix up a field: fly
around with W A S D, Q / E (down / up), Shift (faster), right-drag to look
and the wheel to zoom. Click a tree, bush, building, fence or the windsock to
select it, drag its arrows to move it, and set its size or type in the
panel (Delete removes it); *+ Tree* and *+ Bush* plant where you click,
*+ Hedge* plants a bush every 2.5 m and *+ Fence* draws a fence through the
points you click (Enter finishes); *Flight line* is the line pilots stand
along (click its two ends: you stand at its middle, plus your own pilot
position setting) and *Windsock* puts the windsock where you click. Ctrl+Z undoes. Every change
also changes what you fly into. Edits are saved in your browser for that
field; *Export* saves them to a file (send it in to have them built into
the field for everyone) and *Import* loads one. With Google photorealistic
scenery on, its tiles can be shown under your edits; when flying, Google's
tiles replace the ground and buildings and the trees, hedges and fences
(yours included) are drawn on top.

If the picture is jerky, lower *Menu → View → Graphics*: quality (Low /
Medium / High: how detailed the trees are and how far out, screen
resolution, shadow sharpness) and scenery distance. Both are on the start
screen too.

Barrack Field scenery contains Environment Agency LIDAR data © Environment Agency
copyright and/or database right, licensed under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/),
and map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).

### Surveying a field with a phone

`survey.html` (https://jonsole.github.io/rc-flight-sim/survey.html, or `/dev/survey.html`)
is a page for walking a real field with a phone to make its layout more accurate.
Open it in Chrome on the phone and allow location:

- **Record point**: stand on the spot and keep still; it averages GPS for 5–60 s.
- **Photo here**: a quick point at the current position with a photo and compass heading.
- **Walk a line**: adds a point every 3 m as you walk a fence, hedge or mown edge.

The map shows the site's baked ground map, your position and what you have
recorded. Everything is kept on the phone (IndexedDB) until cleared. **Export zip**
shares `survey.json` plus the photos. Each feature keeps its raw GPS values plus its
National Grid position and the site's world position (`local`: x east, z south
of the pilot), ready for `src/sim/location.js`. The conversion is the same
Helmert WGS84 → OSGB36 shift the baker used for OpenStreetMap, good to about 2 m.
Phone GPS adds 2–5 m on top, so averaging and open ground matter.

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
Hand launch: before throttling up, aileron or rudder turns you round and elevator walks you forward or back, to aim clear of trees.
R = reset, C = camera, G = flight assist, P = pause, H = HUD, M = mute, Esc = menu.

## Phones and tablets

On a touch screen the sim shows two on-screen sticks (Mode 2 by default:
throttle and rudder on the left, elevator and ailerons on the right; the
throttle stays where you leave it, the others spring back) and buttons for
camera, reset, flight assist and the menu. Turn the phone sideways. Stick mode
and showing or hiding the sticks are under **Menu → Transmitter**; a connected
transmitter or gamepad still takes priority.

## Challenges

Pick one on the start screen or under *Menu → Challenges* (*Free flying* for
none). The course is set out in the most open part of the field, in front of
you, worked out from the trees and buildings there (your scenery edits too).
A box at the top shows the clock and progress, a yellow ring or edge arrow
points to what's next, and **R** starts it again. Your best for each
challenge is kept in this browser, per field and difficulty.

Each challenge has three difficulty levels (*Easy*, *Normal*, *Hard*), set
next to the challenge on the start screen or in the Challenges tab:

| Challenge | Easy | Normal | Hard |
| --- | --- | --- | --- |
| Hoops | 7 m hoops, gentle height changes | 5 m | 3.2 m, big climbs and dives |
| Balloon burst | 15 big balloons (1.6 m) up at once, all 8–11 m up | 12, 1 m across, 4–18 m up | 9 small ones (0.6 m), 2–25 m up |
| Limbo | 14 m between the poles | 10 m | 7 m |
| Pylon race | 2 laps | 3 | 5 |
| Streamer cutting | planes at ~7 m/s, 12 m streamers | 8–9 m/s, 8 m | 11–12 m/s, 6 m |
| Spot landing | climb to 10 m, circuit at least 10 m out from the spot | 10 m up, 20 m out | 20 m up, 30 m out |

| Challenge | What to do |
| --- | --- |
| **Hoops** | Eight floating hoops round a loop at different heights. Fly through them in order, either way through; the next one is lit. The clock runs from the first to the last. |
| **Balloon burst** | Against the clock (2, 5 or 10 minutes; 5 to start with): burst as many helium balloons as you can. They're tied to pegs on strings, blown about by the wind and its gusts, and a new one is tied up a couple of seconds after each one goes. Clip a string and the balloon rises away downwind trailing its string: chase it and burst it before it gets out of reach (120 m up or 350 m away). The clock starts when you take off; if you crash, R puts you back in the air and the clock keeps running (*Start again* in the menu starts a new game). |
| **Limbo** | A bar between two poles, starting at 8 m. Fly under it (either way) and it drops, down to 32 cm. Over the top doesn't count; touch it and it falls, ending the run; the poles are solid. Scored by passes. |
| **Pylon race** | Three laps round three inflatable pylons: cross the start line (the white line between two black flags) either way, which sets which way round you race, then round the lit pylon each time, on the outside, on the side its yellow flag sticks out, the way the curved yellow arrow round it points. Later laps must cross the line the same way. Cutting inside one means going back round it, and hitting one is a crash. |
| **Streamer cutting** | Three model aeroplanes fly loops towing a crepe-paper streamer from each wing tip. Cut them with your wings, prop or fuselage, again and again, until only stubs are left; don't hit the aeroplanes. In multiplayer you tow streamers too, and everyone can cut everyone's (the streamer aeroplanes are your own, not shared). |
| **Spot landing** | Take off and climb to 10 m, fly a full 360° circuit round the spot (a red bullseye with white rings at 2, 5 and 10 m and orange cones, painted on the runway), then cut the throttle right back and glide in. Scored by how far from the middle you first touch down (a blue flag marks it): within 1 m is a bullseye. Opening the throttle again after cutting it, or crashing on landing, means no score. |

The code is in `src/game/`: `courses.js` (the courses), `challenges.js`
(clock, scores, HUD, sounds, multiplayer streamers), `ribbon.js` (the
streamers: light paper that drifts with the air, flutters and is towed),
`arena.js` (finding open sky) and `geom.js` (through a hoop, touching a
streamer or a ball).

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
with lift and drag curves that stall and become flat-plate past the stall
(optionally with hysteresis: a stalled wing stays stalled until the nose has
dropped a few degrees below the stall angle, as on the AeroScout).
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
src/aircraft/  aircraft registry (index.js), settings and 3D model files (models/), flight-model builders, the propeller
src/world/     sky, terrain, runway, trees, windsock
src/view/      camera rig (LOS / FPV / chase)
src/input/     transmitter (Gamepad API) + keyboard, expo & rates
src/ui/        OSD/HUD, settings panel
src/game/      challenges: hoops, balloons, limbo, pylon race, streamer cutting, spot landing
src/audio/     synthesised motor and prop sound
tests/         vitest flight-model tests
```

## Aircraft files

Each aircraft's settings are a JSON file in `src/aircraft/models/`, so they
can be read and edited on GitHub:

| File | Aircraft |
| --- | --- |
| `eflite-se5a-900.json` | E-flite S.E.5a 900mm |
| `buschtrottel-shockcub.json` | Buschtrottel ShockCub |
| `buschtrottel-highlander.json` | Buschtrottel Highlander |
| `buschtrottel-agro.json` | Buschtrottel Agro |
| `ft-mini-f22.json` | Flite Test Mighty Mini F-22 |
| `hobbyzone-aeroscout.json` | HobbyZone AeroScout S 2 1.1m |
| `multiplex-easystar.json` | Multiplex EasyStar |

Each has `builder` (the code that turns the settings into a flight model and
3D model: `se5a`, `buschtrottel`, `f22`, `aeroscout` or `easystar`), `id`, `name`, `summary`, `notes`
(explanations, ignored by the code), the builder's settings, `model` (its 3D
model file, below) and `tuning`.
Units are metres, kilograms, newtons and seconds; angles are in degrees
where the name ends in `Deg` (`"elevatorThrowDeg": 12`). `tuning` holds
built-in changes in the Tuning tab's terms (`"elevator": 10`, `"cells": 4`,
`"cgFromLE": 78` ...): paste the `"tuning"` from a Tuning-tab Export there to
make it the model's default for everyone. `src/aircraft/index.js` reads every
file in the folder: a new file (say a copy of the ShockCub with other
colours, prop or mass) is a new aircraft in the list.

## 3D models (Blender)

Each aircraft's 3D model is a glTF file, `src/aircraft/models/<id>.glb`,
named by `"model"` in its JSON file. It is only the look: how it flies comes
from the JSON settings. The files load with the flying field at start-up,
before *Fly* can be pressed. The propeller is the one thing drawn in code
(`src/aircraft/prop.js`), at the file's `prop` marker, so the prop set in the
Tuning tab (size, blades, tips) is the one you see.

**Editing in Blender:** File → Import → glTF 2.0, open the `.glb`. The nose
points along +X, the right wing along −Y, Z is up; units are metres. Edit
away, then File → Export → glTF 2.0 with Format *glTF Binary (.glb)* and
save over the same file. On GitHub, upload it into `src/aircraft/models/`
(Add file → Upload files) to replace the old one. Tick *Data → Mesh → Loose
Edges* when exporting to keep thin lines such as the S.E.5a's rigging wires.

The game finds the parts that move by their object names (Blender's `.001`
endings are fine; children of a named object go with it):

| Name | What it does |
| --- | --- |
| `aileron_R`, `aileron_L` | Ailerons |
| `elevator`, `rudder` | Elevator and rudder |
| `elevon_R`, `elevon_L` | Elevons (the F-22) |
| `wheel_R`, `wheel_L` | Roll along the ground and ride up on the tyre |
| `tailwheel` | Steers with the rudder (a nose wheel too: the AeroScout's is named this) |
| `prop` | An empty on the prop shaft, its X axis along it: the prop set in the Tuning tab is drawn and spun there (don't model the prop) |
| `pilot` | Hidden in the FPV (cockpit) view |
| `wing_R`, `wing_L`, `tail`, `gear_R`, `gear_L`, `canopy` | Groups that break off in a crash |

A control surface (and a wheel or tail wheel) turns about its object's
**origin**, along the object's **local X axis** (the red arrow; show it with
Object properties → Viewport Display → Axes). Put the origin on the hinge
line and the X axis along the hinge, either way round: the game works out
which way is trailing edge down. To move or turn just the origin, tick
Options → Transform → Affect Only *Origins* in the 3D view. Everything else
can be named and arranged however you like. A material whose name starts
with `decal` (roundels, lettering) is drawn over the surface it sits on
without flickering. The flat-shaded foam pieces come in as loose triangles:
Mesh → Clean Up → Merge by Distance joins them, then Shade Flat keeps the
faceted look.

## Adding an aircraft

Each aircraft is a registry entry in `src/aircraft/index.js`, built from its
JSON file:

```js
{ id, name, summary, defaultAssist, def, geometry, views, modelFile, createModel }
```

- `def`: the flight model (mass, inertia, lifting surfaces, contact points,
  motor, battery, trim, assist gains), as consumed by `src/sim/aircraft.js`.
- `views`: camera mounts in body axes (`cockpit`, `pod`), `span` for LOS
  auto-zoom, and `chase` distances.
- `createModel({ prop })`: returns `{ root, parts, update(aircraft, dt), setPilotVisible(bool) }`
  from the model file (`"model"` in the JSON file, loaded by `loadModelFiles()`),
  with the propeller drawn in code; `prop` is the prop as tuned.
- `def.handLaunch` (optional): `{ height, speed, pitch, throttle }` for a model
  with no wheels. It starts in the pilot's hand and is thrown along its nose
  once the throttle reaches `throttle`. The wheel tests are skipped for it.
- `def.cruiseThrottle` (optional, default 0.5): the throttle the trim test
  flies at, for an overpowered model that climbs at half throttle.

Another size of S.E.5a, or another Buschtrottel, is just another JSON file.
A different type needs its own builder (its flight model) and a model file
made in Blender. The flight
tests run automatically for every registered aircraft.

## Multiplayer

Players who join the same room code see each other's aeroplanes (menu → Multiplayer, or share an invite link `…/?room=CODE`). Each browser flies its own aeroplane and sends its state about 15 times a second through a small relay, `server/`: a Cloudflare Worker with one Durable Object per room (`server/relay.js` is the same relay as a plain Node server). Everything goes over secure WebSocket on port 443, so it works behind NAT and firewalls; no peer-to-peer connections are made.

- Hosting: Cloudflare Workers Builds deploys the relay from this repository on every push to main, using `wrangler.toml` at the repo root (no build command; deploy command `npx wrangler deploy`).
- Local relay: `cd server && npm install && npm start` (or `npx wrangler dev`), then set Server to `ws://127.0.0.1:8787` in the Multiplayer menu.
- The game connects to `wss://rc-flight-sim.jon-sole.workers.dev` (`src/net/config.js`, or build with `VITE_MP_SERVER`).
