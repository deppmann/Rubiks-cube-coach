// Teaching content for each solver stage. Pure data; must match src/solver.js
// (white on the bottom, yellow on top; algorithms below are exactly what the solver uses).

// ---- How to hold the cube and which hand/finger makes each move ---------------------
// One beginner-friendly sentence per move, consistent with the hands animation in
// src/hands.js (right hand turns R, F, B; left hand turns L; right index flicks U; left ring
// pulls D; both hands turn y). Home grip: cube in both hands, white on the bottom, green facing
// you, thumbs on the front face near the bottom corners, fingers wrapped around the back.
export const HOME_GRIP = 'Home grip: hold the cube with both hands, thumbs on the front face near the bottom corners and fingers wrapped around the back, index fingers resting near the top back edge.';

const GRIP = {
  U: 'U: right index finger pushes the top layer to the left.',
  "U'": "U': left index finger pushes the top layer to the right.",
  U2: 'U2: right index finger flicks the top layer to the left twice.',
  D: 'D: left ring finger pulls the front of the bottom layer to the right.',
  "D'": "D': right ring finger pulls the front of the bottom layer to the left.",
  D2: 'D2: left ring finger pulls the bottom layer to the right twice.',
  R: 'R: right hand — turn the right side up and away, like turning a doorknob.',
  "R'": "R': right hand — turn the right side down and toward you, like turning a doorknob back.",
  R2: 'R2: right hand — turn the right side up and over twice, a doorknob turn each time.',
  L: 'L: left hand — turn the left side down and toward you, like turning a doorknob.',
  "L'": "L': left hand — turn the left side up and away, like turning a doorknob back.",
  L2: 'L2: left hand — turn the left side down and over twice, a doorknob turn each time.',
  F: 'F: right hand — pinch the front layer with thumb and fingers and turn it clockwise, top edge to the right.',
  "F'": "F': left hand — pinch the front layer with thumb and fingers and turn it counter-clockwise, top edge to the left.",
  F2: 'F2: right hand — pinch the front layer with thumb and fingers and turn it a half turn.',
  B: 'B: right hand — reach around the back and turn the back layer so its top edge moves to your left.',
  "B'": "B': right hand — reach around the back and turn the back layer so its top edge moves to your right.",
  B2: 'B2: right hand — reach around the back and turn the back layer a half turn.',
  y: 'y: both hands turn the whole cube to the left, so the right face comes to the front.',
  "y'": "y': both hands turn the whole cube to the right, so the left face comes to the front.",
  y2: 'y2: both hands turn the whole cube a half turn, so the back face comes to the front.',
  x: 'x: both hands tip the whole cube up and away, so the front face goes to the top.',
  "x'": "x': both hands tip the whole cube down and toward you, so the top face comes to the front.",
  x2: 'x2: both hands tip the whole cube over a half turn, front to back.',
  z: 'z: both hands turn the whole cube clockwise like a steering wheel, top face to the right.',
  "z'": "z': both hands turn the whole cube counter-clockwise like a steering wheel, top face to the left.",
  z2: 'z2: both hands turn the whole cube a half turn like a steering wheel.',
};

// Short instruction for one move token (U D R L F B, x y z, slices and wide turns; ', 2).
export function gripFor(move) {
  const t = String(move ?? '').replace(/[’`]/g, "'").trim().replace(/2'$/, '2');
  if (GRIP[t]) return GRIP[t];
  const m = /^([MESurfdlb])(2|')?$/.exec(t);
  if (m) {
    const half = m[2] === '2' ? ' a half turn' : m[2] === "'" ? ' the other way' : '';
    return `${t}: hold the cube steady with your left hand and turn that layer${half} with your right fingers, then return to the home grip.`;
  }
  return `${t || 'Move'}: turn that layer with the hand that reaches it most easily and hold the cube steady with the other, then return to the home grip.`;
}

export const NOTATION = [
  { move: 'U', description: 'Turn the top layer a quarter turn clockwise, as if you were looking down at it from above.' },
  { move: "U'", description: 'The apostrophe (say "prime") means the opposite way: a quarter turn counter-clockwise.' },
  { move: 'U2', description: 'A 2 means a half turn (two quarter turns). Direction does not matter.' },
  { move: 'D', description: 'Turn the bottom layer clockwise as if you were looking at it from below (so it moves the opposite way to U when seen from above).' },
  { move: 'R', description: 'Turn the right layer (the side facing your right hand) clockwise as if you were looking straight at it: the front of that layer moves up.' },
  { move: 'L', description: 'Turn the left layer clockwise as if you were looking straight at it: the front of that layer moves down.' },
  { move: 'F', description: 'Turn the front layer (the one facing you) clockwise, like turning a steering wheel to the right.' },
  { move: 'B', description: 'Turn the back layer clockwise as if you were looking at it from behind the cube.' },
  { move: 'y', description: 'Turn the whole cube like a U move (clockwise from above) without changing the puzzle, so the right-hand face becomes the front. Use it to bring a new side in front of you.' },
].map((n) => ({ ...n, grip: gripFor(n.move) }));

const HOLD = 'Hold the cube with white in the middle of the bottom face and yellow on top, green facing you.';

export const LESSONS = {
  cross: {
    goal: 'Make a white cross on the bottom layer where each white edge also matches the center of the side it touches.',
    recognize: 'Look for the four white-edge pieces (white plus one other color). The cross is done when the white stickers form a plus on the bottom and every side sticker of those edges matches its center.',
    algorithms: [
      { name: 'Insert an edge', moves: 'F2', when: 'The white edge is on the top layer, sitting directly above its home slot with the white sticker facing up and its side color matching the front center: a half turn drops it into the bottom. The same half turn also lifts a white edge that is in the wrong bottom spot up to the top.' },
      { name: 'Flip an edge', moves: "R' F R F'", when: 'The white edge is on the top layer at the front with white facing you: this brings it to the top-right with white facing up, without disturbing the cross. Then turn U and insert it.' },
    ],
    tips: [
      HOLD,
      'A letter names a face and its turn is always clockwise as if you looked straight at that face. "R" turns the face on your right, "U" the face on top.',
      'To bring another side to the front, turn the whole cube with y (like a U turn of the entire cube) instead of changing your grip.',
      'Turn the top layer (U) until the edge is right above the slot it belongs in, then do F2 to send it down.',
      'Do not worry about speed yet: solve one edge at a time and check the side colors against the centers.',
    ],
    speedTips: [
      'Solve the cross on the bottom so you never have to flip the cube afterwards.',
      'Plan the whole cross during the 15 seconds of inspection, then execute without pausing.',
      'Aim for 8 moves or fewer and find edges while you turn instead of stopping to search.',
      'Avoid regrips: choose cross moves that keep your hands in their normal position.',
    ],
  },

  whiteCorners: {
    goal: 'Finish the whole white layer by placing the four white corners so each matches the two side centers it touches.',
    recognize: 'Find a white corner in the top layer. Turn U until it is directly above the slot between its two side colors (with the slot at front-right). If a white corner is stuck in the bottom in the wrong place, lift it out with the same algorithm first.',
    algorithms: [
      { name: 'Sexy move (corner insert)', moves: "R U R' U'", when: 'The corner sits above its slot at the front-right. Repeat 1 to 5 times until the corner drops in with white facing down.' },
    ],
    tips: [
      HOLD,
      'Use y to rotate the cube so the slot you are filling is at the front-right, where your right hand can reach it.',
      'R means turn the right side clockwise (front of it moves up). Say the algorithm out loud as you turn.',
      "Keep repeating R U R' U' with the corner in the front-right of the top; it comes down with white facing down after 1, 3 or 5 repeats.",
      'Do not stop halfway through a repeat: the bottom cross only gets scrambled temporarily and is restored when the corner drops in.',
    ],
    speedTips: [
      "Finger trick for R U R' U': right thumb stays under, the right index finger flicks U toward you, and a wrist push does R.",
      'Look ahead: while inserting one corner, find where the next white corner is.',
      'Later, learn to build the first two layers together (F2L) instead of corners then edges.',
      'Avoid regrips: rotate the cube with y only when necessary.',
    ],
  },

  middle: {
    goal: 'Fill the four middle-layer edges so the first two layers are complete.',
    recognize: 'Turn the cube to look at the top layer. Find an edge with no yellow on it. Turn U until its front sticker matches the front center. Then check the top sticker: if it matches the right center, use the right algorithm, if it matches the left center, use the left one.',
    algorithms: [
      { name: 'Edge to the right', moves: "U R U' R' U' F' U F", when: 'The front sticker matches the front center and the edge must go to the front-right slot.' },
      { name: 'Edge to the left', moves: "U' L' U L U F U' F'", when: 'The front sticker matches the front center and the edge must go to the front-left slot.' },
    ],
    tips: [
      HOLD,
      'L means turn the left face clockwise as seen from the left (front of it moves down); R is the mirror.',
      'If every top edge has yellow, but a middle slot holds a wrong edge, run one of the algorithms on that slot to pop it out to the top.',
      'Use y to bring the edge you are solving to the front.',
      'The algorithms are mirror images: right one uses R and F, left one uses L and F reversed.',
    ],
    speedTips: [
      'Learn to see the edge and the slot together: this leads towards F2L, where corner and edge go in as a pair.',
      'Do not rotate the cube between the algorithm and finding the next edge: look for one while doing the other.',
      'Practice the two algorithms until your hands do them without thinking.',
      'Avoid regrips by choosing the front face that lets you use R-side triggers.',
    ],
  },

  yellowCross: {
    goal: 'Make a yellow cross (a plus) on top. The corners do not matter yet.',
    recognize: 'Look at the yellow stickers on the top layer only. You have either just the center (a dot), an L shape (two touching edges), a straight line (two opposite edges) or the cross already.',
    algorithms: [
      { name: 'Yellow cross', moves: "F R U R' U' F'", when: 'Line: hold it horizontal (left to right). L shape: hold it so the two yellow edges point to the back and the left. Dot: do it once, then continue as for an L shape. Repeat until a cross appears.' },
    ],
    tips: [
      HOLD,
      'F turns the front face clockwise. This algorithm is F, then the sexy move R U R\' U\', then F back.',
      'Dot then L then line then cross: you never need more than three runs.',
      'Only the yellow edges matter here: ignore whether the side colors match.',
    ],
    speedTips: [
      "Do the R U R' U' part with the finger trick: right index flicks U.",
      'Learn to recognize dot, L and line at a glance so you do not stop to think.',
      'Later, 2-look OLL uses this same algorithm as its first look, then a second one for the corners.',
      'Try to do it without regripping between F and R.',
    ],
  },

  yellowEdges: {
    goal: 'Move the yellow-cross edges so each side color also matches its center color.',
    recognize: 'Turn U until as many top-layer edges as possible match their side centers. Either two neighbors match (hold them at back and right) or two opposite ones match (hold one at the back).',
    algorithms: [
      { name: 'Edge cycle (Sune)', moves: "R U R' U R U2 R'", when: 'Line up so that at least one edge matches at the back, then repeat with U turns in between until all four match. This algorithm is also known as the Sune.' },
    ],
    tips: [
      HOLD,
      'U2 means a half turn of the top layer; direction does not matter.',
      'Turning U can always make at least two edges match. If the two are opposite each other, do the algorithm once with one of them at the back, then turn U and look again: now two neighbours match.',
      'After finishing, turn U until all four edges match their centers.',
    ],
    speedTips: [
      'The Sune is one of the most useful algorithms in cubing: it appears again in OLL.',
      'Practice the trigger R U R\' until it flows, and finish with U2 as a single wrist move.',
      'Look ahead to where the yellow corners are during the last turns.',
      'Eventually learn full PLL edge cases to skip this step.',
    ],
  },

  yellowCornersPosition: {
    goal: 'Move the yellow corners into the right places (they may still be twisted).',
    recognize: 'A corner is in the right place when its three colors match the three centers it touches, even if the yellow sticker is not on top. Find one correct corner and hold it at the front-right of the top layer. If none is correct, do the algorithm once and look again.',
    algorithms: [
      { name: 'Corner cycle', moves: "U R U' L' U R' U' L", when: 'Hold a correct corner at the front-right of the top, then do it; it cycles the other three corners. Repeat if they are still wrong.' },
    ],
    tips: [
      HOLD,
      'L means the left face clockwise as seen from the left.',
      'If no corner is correct, do the algorithm from any angle once, and then one will be.',
      'Do not worry about twisted yellow stickers yet, they are fixed in the last step.',
    ],
    speedTips: [
      'Look for the corner that is already right before the algorithm: this leads to 2-look PLL.',
      'Learn the corner swap as a three-corner cycle so you can predict it.',
      'Avoid rotating the cube between algorithms by planning the angle during the previous step.',
      'Later, learn the full PLL algorithms one at a time.',
    ],
  },

  yellowCornersOrient: {
    goal: 'Twist each yellow corner in place so the whole top face is yellow and the cube is solved.',
    recognize: 'Every corner is in the right place, but some have yellow on the side. Hold an unsolved corner at the front-right of the top layer.',
    algorithms: [
      { name: 'Twist a corner', moves: "R' D' R D", when: 'Repeat twice or four times until the corner shows yellow on top, then turn only U (not the whole cube) to bring the next unsolved corner to the front-right. Do not worry that the cube looks scrambled in between.' },
    ],
    tips: [
      HOLD,
      'Keep the same front face during the whole step: only turn the top layer between corners.',
      "The cube looks scrambled while you work. It is fine: once the last corner is done, the last U turns align everything.",
      'D means turn the bottom layer clockwise as seen from below.',
      'Finish with U turns until the top layer lines up with the sides.',
    ],
    speedTips: [
      "R' D' R D is the mirror of the sexy move; practice it as one fluid trigger.",
      'Later, learn 2-look OLL and 2-look PLL to shorten the last layer.',
      'Look at how many corners need twisting before starting so you can plan U turns.',
      'The long-term goal is the full CFOP method with F2L.',
    ],
  },
};

export const ROADMAP = [
  { milestone: 'Solve it with the coach', how: 'Follow the step-by-step moves and read why each is made until you know all seven stages.' },
  { milestone: 'Solve without looking at the moves', how: 'Practice each stage separately from the algorithm cards, then solve a full cube from memory of the steps.' },
  { milestone: 'Sub-2 minute', how: 'Learn the finger tricks, stop regripping, and use the 15 seconds of inspection to plan the cross.' },
  { milestone: 'Learn the 4-look last layer', how: 'Replace the beginner last-layer steps with 2-look OLL and 2-look PLL, about ten algorithms.' },
  { milestone: 'F2L intuitive', how: 'Insert each corner and its middle edge together as a pair, and practice look-ahead.' },
  { milestone: 'Full CFOP', how: 'Cross, F2L, OLL, PLL: learn full OLL and PLL over time, and drill with the timer and ao5/ao12.' },
];
