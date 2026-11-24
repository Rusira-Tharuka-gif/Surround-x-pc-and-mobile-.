const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const src = 'public/assets/aistudio/Logo_9629bfbd.jpg';
if (!fs.existsSync(src)) {
  console.error('Source logo not found at ' + src);
  process.exit(1);
}

const tmpDir = '/tmp/surroundx_icons';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

// 1. Crop 720x720 centered at (512, 450)
const emblemCrop = path.join(tmpDir, 'emblem_crop_720.png');
execFileSync('convert', [src, '-crop', '720x720+152+90', '+repage', emblemCrop]);

// 2. Resize to 590x590 for inner safe zone (590px / 1024px = 57.6%, fits inside 72dp / 108dp = 66.7% safe zone)
const emblem590 = path.join(tmpDir, 'emblem_590.png');
execFileSync('convert', [emblemCrop, '-resize', '590x590', emblem590]);

// 3. Create anti-aliased circular alpha mask for the 590x590 emblem so corners outside the acoustic ring are transparent
const mask590 = path.join(tmpDir, 'mask_590.png');
execFileSync('convert', [
  '-size', '590x590', 'xc:black',
  '-fill', 'white',
  '-draw', 'circle 295,295 295,25',
  '-blur', '0x2',
  mask590
]);

const emblemTransparent = path.join(tmpDir, 'emblem_trans_590.png');
execFileSync('convert', [
  emblem590, mask590,
  '-alpha', 'off',
  '-compose', 'CopyOpacity',
  '-composite',
  emblemTransparent
]);

// 4. Master 1024x1024 transparent foreground
const masterForeground = path.join(tmpDir, 'master_foreground_1024.png');
execFileSync('convert', [
  '-size', '1024x1024', 'xc:none',
  emblemTransparent,
  '-gravity', 'center',
  '-composite',
  masterForeground
]);

// 5. Master 1024x1024 background (acoustic surround background)
const masterBackground = path.join(tmpDir, 'master_background_1024.png');
execFileSync('convert', [
  src,
  '-crop', '880x880+72+10',
  '+repage',
  '-resize', '1024x1024',
  masterBackground
]);

// 6. Master 1024x1024 composite (Background + Foreground)
const masterComposite = path.join(tmpDir, 'master_composite_1024.png');
execFileSync('convert', [
  masterBackground,
  masterForeground,
  '-gravity', 'center',
  '-composite',
  masterComposite
]);

// 7. Generate all densities
const densities = [
  { name: 'mipmap-mdpi', iconSize: 48, adaptiveSize: 108 },
  { name: 'mipmap-hdpi', iconSize: 72, adaptiveSize: 162 },
  { name: 'mipmap-xhdpi', iconSize: 96, adaptiveSize: 216 },
  { name: 'mipmap-xxhdpi', iconSize: 144, adaptiveSize: 324 },
  { name: 'mipmap-xxxhdpi', iconSize: 192, adaptiveSize: 432 },
];

const resDir = path.join('android', 'app', 'src', 'main', 'res');

for (const d of densities) {
  const dir = path.join(resDir, d.name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // ic_launcher_foreground.png (adaptiveSize x adaptiveSize)
  const fgOut = path.join(dir, 'ic_launcher_foreground.png');
  execFileSync('convert', [masterForeground, '-resize', `${d.adaptiveSize}x${d.adaptiveSize}`, fgOut]);

  // ic_launcher_background.png (adaptiveSize x adaptiveSize)
  const bgOut = path.join(dir, 'ic_launcher_background.png');
  execFileSync('convert', [masterBackground, '-resize', `${d.adaptiveSize}x${d.adaptiveSize}`, bgOut]);

  // ic_launcher.png (iconSize x iconSize)
  const legacySquare = path.join(dir, 'ic_launcher.png');
  // Create rounded rectangle mask for legacy icon
  const r = Math.round(d.iconSize * 0.16);
  const sqMask = path.join(tmpDir, `sqmask_${d.iconSize}.png`);
  execFileSync('convert', [
    '-size', `${d.iconSize}x${d.iconSize}`, 'xc:none',
    '-fill', 'white',
    '-draw', `roundrectangle 0,0 ${d.iconSize - 1},${d.iconSize - 1} ${r},${r}`,
    sqMask
  ]);
  execFileSync('convert', [
    masterComposite,
    '-resize', `${d.iconSize}x${d.iconSize}`,
    sqMask,
    '-compose', 'DstIn',
    '-composite',
    legacySquare
  ]);

  // ic_launcher_round.png (iconSize x iconSize)
  const legacyRound = path.join(dir, 'ic_launcher_round.png');
  const roundMask = path.join(tmpDir, `roundmask_${d.iconSize}.png`);
  const rad = d.iconSize * 0.5;
  execFileSync('convert', [
    '-size', `${d.iconSize}x${d.iconSize}`, 'xc:none',
    '-fill', 'white',
    '-draw', `circle ${rad},${rad} ${rad},1`,
    roundMask
  ]);
  execFileSync('convert', [
    masterComposite,
    '-resize', `${d.iconSize}x${d.iconSize}`,
    roundMask,
    '-compose', 'DstIn',
    '-composite',
    legacyRound
  ]);

  console.log(`Success generating assets for ${d.name}: ${d.iconSize}x${d.iconSize} and ${d.adaptiveSize}x${d.adaptiveSize}`);
}

console.log('All Android mipmap icon densities generated successfully!');
