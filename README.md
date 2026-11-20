# PrismDrop — Live Raycasting Pachinko & Complication Lab

**PrismDrop** is an interactive, zero-build web tool for designing and mathematically analyzing pachinko, Plinko, and roguelike chance machines (inspired by *Peglin*, *Nubby's Number Factory*, *Ballionaire*, and *Luck be a Landlord*)—built in the spirit of [AnyDice](https://anydice.com/).

Instead of rolling random balls one at a time and guessing how a board behaves, PrismDrop deterministically computes the **entire outcome distribution** in real time as you place, move, toggle, or build complications—showing both **how the curve changes** and **how a Trained player compares to a Naive player**.

---

## Quick Start

No install, bundler, or backend is required.

1. **Open directly:** Double-click [`index.html`](index.html) in your file manager (works over `file://` in Firefox, Chrome, Edge, and Safari).
2. **Or run a local static server:**
   ```bash
   npx serve .
   # or
   python -m http.server 8000
   ```

### Optional URL Parameters
You can jump straight into any preset and solver mode via query parameters:
```text
index.html?preset=peglinDelve&mode=physics
```
* `preset`: `galton`, `bimodalVault`, `peglinDelve`, `ballionaireMill`, `bumperCriticality`, `splitterCascade`, `portalWind`, `opticalLaser`
* `mode`: `physics` (default) or `markov`

---

## Live Desktop Clock App (Electron)

* **Run as a standalone Electron desktop clock app:** Double-click [`Launch-PrismClock.bat`](Launch-PrismClock.bat) or run `npm start` (or `npm run lab` to launch directly into the Design Lab).
  * Drag anywhere on the clock to move it, quick-click to drop a live glowing ball, scroll wheel to resize, and hover the bottom edge for controls (**👻 Pass** lets clicks pass through the clock board while keeping the bottom dock clickable to unlock—or press `Ctrl+Shift+T` / use the System Tray icon).
* **Build a Windows `.exe` / installer:**
  ```bash
  npm install
  npm run build            # NSIS Windows installer in dist/
  npm run build:portable   # Single-file portable .exe in dist/
  ```
* **Or open [`clock.html`](clock.html) directly in a browser** for a full-screen (`F11`) screensaver.

## First-Time User Walkthrough (5 Minutes)

### 1. Start from the Baseline Bell Curve
PrismDrop opens on **Classic Galton (Bell Curve)** in **Physics Raycaster** mode.
* Every glowing line on the board is a **deterministic trajectory** cast from the top launch rail.
* On the right, **Outcome Distribution** shows the probability curve for a **Naive** player (amber, wide aim spread) vs. a **Trained** player (cyan, tight aim spread). Notice they aren't drastically far apart yet—independent additive pegs naturally regress toward the mean.

### 2. Add Complications & Watch the Curve Warp
1. Pick a piece from the **Complications Palette** on the left—try **Bumper**, **×2 Mult**, **Splitter**, **Mirror Wall**, or **1-Way Gate**.
2. Click on the board to place circles/portals/zones, or **click and drag** to draw angled walls and gates.
3. Click **Baseline vs Current** above the Outcome Distribution chart to compare your modified board (solid cyan) directly against the original clean lattice (dashed gray).
   * Click **Lock Baseline** in the top bar at any time to snapshot your current board as the new dashed reference.
4. Use **Complication Layers** (bottom-left) to check/uncheck individual complications on and off so you can isolate emergent synergies.

### 3. Trace What Caused Any Outcome (Reverse Attribution)
* **Hover or click any bar** in the **Outcome Distribution** chart—or any **bottom slot** at the foot of the board—to dim everything else and illuminate *only* the rays responsible for that exact score or slot. (Click again or press `Esc` to unlock.)
* **Hover the top launch rail** or anywhere along the **Aim Sensitivity Landscape** to inspect a single reflection ray with bounce-by-bounce badges (`+25`, `×2`, `SPLIT`, `WARP`, `POP`).
* Press **`Space`** (or click **▶ Drop Ball** / **Burst ×5**) to watch animated balls travel along the exact traced trajectories.

### 4. Test Quotas & Compare Naive vs. Trained Skill Users
* Switch the distribution chart to **At Least (CCDF)** ($P(X \ge x)$) to answer *"What are my odds of beating the stage rent/quota?"*
* **Drag the red vertical Quota line** directly inside the chart and watch the live `Trained ≥Q` and `Naive ≥Q` pass-rate pills update.
* In **Skill Users & Stage Quota** (bottom-right), adjust `Aim Spread (σ)` for both players, toggle **Trained Auto-Aim** (`Maximize Expected Score` vs. `Maximize Quota Pass Rate`), or drag the **`T`** and **`N`** handles directly on the board's launch rail or sensitivity landscape.
* When testing multiplicative or multi-ball presets (like **Splitter Cascade**), check **Log Axis** so rare massive jackpots don't compress normal runs against the left wall.

### 5. Compare Both Solver Engines
Use the **Physics Raycaster | Exact Markov (Provable)** switcher in the top bar to view the **exact same board** through two complementary lenses:
* **Physics Raycaster:** Continuous 2D ballistic reflections (or set **Gravity = `0`** for straight-line optical laser mirrors).
* **Exact Markov (Provable):** Turns your board into a glowing Sankey probability network solved in closed form via $(I - Q)^{-1}$ and exact AnyDice-style PMF convolution. Hover any peg to see its exact expected visits $E[\text{hits}]$, or click any bottom slot for **exact Bayesian reverse attribution** $P(\text{path} \mid \text{slot})$.

---

## Built-In Complications & What They Do Mathematically

To break out of a standard Galton bell curve, a complication must break one of the Central Limit Theorem's assumptions:

| Complication | Mechanic | Statistical Effect |
| :--- | :--- | :--- |
| **Peg** | Standard static bounce (`+5`) | Independent additive steps → Bell curve |
| **Pop Peg** | Disappears after 1 hit (persists across multi-shot rounds!) | Path dependence & board carving (*Peglin* / *Nubby's*) |
| **Bumper** | High restitution + outward velocity kick | Cyclic loops → Exponential / heavy right tails |
| **×2 Mult** | Multiplies ball score (`×2`) | Breaks additivity → Log-normal right skew |
| **Splitter** | Spawns extra deterministic balls (`⑂2`) | Compounding multi-ball variance |
| **Synergy +15** (`✦`) | Permanently buffs `+score` of all pegs within its aura radius | Cross-peg scaling synergies (*Ballionaire* / *Luck be a Landlord*) |
| **3-Hit Pin** (`3×`) | Cooldown counter firing a big bonus every *N*th hit | Threshold burst spikes across shots/loops |
| **Refresh** (`⟳`) | Restores all popped pegs immediately on hit | Resets board depletion mid-round (*Peglin* / *Nubby's*) |
| **Bomb Peg** (`✹`) | Detonates & scores all pegs inside its blast radius | Chain-reaction clearing + instant corridor carving |
| **Spin Bias** | Deflection angle + tangential spin kick | Breaks symmetry → Skewness & directional shift |
| **Mirror Wall** | Angled reflector / funnel segment | Breaks independence → Channels & multimodality |
| **1-Way Gate** | Balls pass through along the cyan arrow, bounce off the reverse side | Traps balls inside bumper vaults / chambers |
| **Spinner** (`✳`) | Rotating blade imparting live angular surface velocity | Dynamic timing-sensitive deflection & spin |
| **Warp Portal** | Teleports ball from `IN` to draggable `OUT` along exit angle | Long-range recycling loops & multimodal tiers |
| **Wind Drift** | Lateral/vertical acceleration field | Continuous directional skew |
| **Gravity Well** | Radial attraction (`−`) or repulsion (`+`) + optional drag | Focuses or disperses trajectories into pockets |

### Board Geometry, Multi-Shot Rounds & Special Bottom Slots
* **Board Size & Lattice Generator:** Resize `Board Width` (`360–820 px`) and `Board Height` (`480–1000 px`), switch **Chamber Shape** (`Rectangle`, `Pachinko Arch Dome`, `Pinball Funnel Gutters`, `Diamond Prism Bevels`), and regenerate base lattices (`Staggered Galton`, `Square Grid`, `Pyramid`, `Hex Rings`) while keeping your placed complications.
* **Multi-Shot Rounds (`Shots / Round: 1–5`):** Simulates consecutive shots where popped pegs, synergy aura buffs, and `Trigger Every N` counters persist across the round until a **Refresh Peg (`⟳`)** or **Refresh Slot (`F`)** restores the board—displaying a live **Round EV progression strip** (`Shot 1 → Shot 2 → Shot 3`).
* **Special Bottom Slot Tokens:** In the **Bottom Slots** field, mix numbers with special mechanics:
  * `50R` or `R` — **Replay** (+value and launch a free bonus ball)
  * `40F` or `F` — **Refresh** (+value and restore all popped pegs)
  * `H` or `/2` — **Tax / Hazard** (halves the ball's score)
  * `x2` or `×3` — **Slot Multiplier** (multiplies the ball's score)
* **2D Rigid-Body Realism:** Toggle **2D Spin, Friction & Magnus Curve**, **Ball-to-Ball Splitter Collisions**, and a **Moving Bonus Bucket (`×2 + Replay`)** with an adjustable **Moving Start Phase (`0°–360°`)** (plus oscillating `Oscillate X/Y` kickers in the Inspector).

### Building & Sharing Custom Complications
* **+ Build Complication** opens the Custom Complication Builder where you can combine any geometry, physics, bounce bias, score add/multiply, ball splitting, pop count, portal angle, or force vector. Saved pieces persist in `localStorage` and appear in your **Custom Built** palette.
* **Import / Export** outputs your full board, settings, and custom templates as JSON. When importing, choose **Load Full Board** to replace everything or **Merge Complications Only** to bring a saved complication pack onto your current board.

---

## Understanding the Analytics HUD

* **Expected Score ($\mu$) & Median ($P_{50}$):** When $\mu$ is much larger than the median, rare jackpot spikes are driving your average.
* **Variety (Entropy) & Skewness:** Normalized Shannon entropy ($0\text{–}100\%$) measures how close the distribution is to flat uniform unpredictability; skewness measures left/right asymmetry.
* **Fat-Tail Ratio ($P_{99} / P_{50}$):** Quickly flags heavy-tail / combo-explosion regimes.
* **Skill Agency (Mutual Information, in bits):** Quantifies how much outcome variety is actually controllable by a player's aim precision vs. irreducible chaos. A high Trained/Naive EV ratio paired with high Mutual Information means a complication creates real skill expression rather than pure noise.

---

## Solver Accuracy & Proof Verification Banner

The banner at the top of the right-hand analytics panel reports live numerical accuracy for whichever engine is active:

1. **Physics Raycaster (`Exact Analytic Parabola` / `Rigid-Body Lockstep CCD` + `Adaptive Trained Oversampling`)**
   * Uses **exact analytical parabola–circle quartic root isolation** (via cubic critical-point bracketing + Newton–Bisection, $< 10^{-13}$ precision) and exact parabola–capsule quadratic intersections whenever the board is static without spin/ball-collisions/force-zones; automatically switches to **75Hz lockstep rigid-body CCD** when **2D Spin & Friction**, **Ball-to-Ball Collisions**, **Moving Spinners / Oscillators**, **Moving Bonus Bucket**, or **Force Zones** are enabled.
   * Automatically casts dense rays inside the Trained user's $\pm 3.5\sigma$ aim window for higher-precision Gaussian quadrature.
   * Compares full-grid vs. half-grid CCDFs to compute the **Kolmogorov–Smirnov (KS) convergence gap**:
     * **✓ Converged** (`< 4%` KS): curve is numerically stable.
     * **~ Moderate KS** (`4–10%` KS): mild sensitivity—try raising **Ray Resolution**.
     * **⚠ Chaotic Ridge** (`≥ 10%` KS): the narrow Trained target sits on fractal chaos (too unstable for real players to reproduce reliably).

2. **Exact Markov Mode (`Provable (I − Q)⁻¹`)**
   * Solves the absorbing Markov fundamental matrix $N = (I - Q)^{-1}$ and slot absorption matrix $B = NR$ via partial-pivoting Gaussian elimination, and propagates exact sparse score PMFs (with discrete self-convolution for splitters).
   * Displays exact **Slot row error** (typically $\sim 10^{-16}$) and **Absorbed mass %** (or flags a **Supercritical Trap** if a 100% inescapable loop has no exit).
   * Selecting any circle node while in Markov mode exposes optional **Markov P(Right)** and **Markov Loop Prob** overrides in the Inspector so you can specify exact transition probabilities directly.

---

## Keyboard & Canvas Shortcuts

| Input | Action |
| :--- | :--- |
| **Click / Drag object** | Select and move pegs, bumpers, zones, or portal `IN` / `OUT` nodes |
| **Drag wall endpoints** | Rotate and resize Mirror Walls & 1-Way Gates (flip ends to reverse a 1-Way Gate) |
| **Drag `T` or `N` handle** | Manually reposition Trained or Naive aim target on the rail or sensitivity chart |
| **Click chart bar / bottom slot** | Lock or unlock Reverse Attribution highlight |
| **`Space`** | Drop an animated test ball along the inspected (or Trained) trajectory |
| **`D`** | Duplicate selected object |
| **`Delete` / `Backspace`** | Delete selected object |
| **`Ctrl+Z` / `Cmd+Z`** | Undo (up to 35 edits) |
| **`Esc`** | Return to Select tool and clear locked attribution highlights |

---

## Project Structure

```text
index.html        App layout, controls, and native modal dialogs
styles.css        Responsive CSS Grid workspace with automatic light/dark theming
js/math.js        Exact geometry (ray/parabola vs circle/capsule), stats, KS convergence, Gaussian elimination
js/engine.js      Deterministic continuous physics & 0-G optical raycaster + adaptive local sweeps
js/markov.js      Provable closed-form absorbing Markov solver (I-Q)^-1 + exact sparse PMF convolution
js/presets.js     Built-in complication templates and 6 curated starter boards
js/boardView.js   High-DPI interactive optical chamber, Sankey Markov renderer, and test-ball animator
js/charts.js      High-DPI AnyDice-style PMF/CCDF/Slot chart and Aim Sensitivity Landscape
js/app.js         State management, undo stack, Inspector, Custom Builder, and JSON Import/Export
```
