// learn/moves.html: mounts the 2D animation at once, and loads three.js for the 3D scenes only when
// that panel comes near the screen.

import { mountMoves2d } from './moves2d.js';

const panel2d = document.getElementById('moves2d');
if (panel2d) mountMoves2d(panel2d);

const panel3d = document.getElementById('moves3d');
if (panel3d) {
  const io = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting) return;
    io.disconnect();
    try {
      const { mountMoves3d } = await import('./moves3d.js');
      mountMoves3d(panel3d);
    } catch (err) {
      panel3d.querySelector('.placeholder').textContent = 'The 3D view could not be loaded in this browser.';
      console.error(err);
    }
  }, { rootMargin: '300px' });
  io.observe(panel3d);
}
