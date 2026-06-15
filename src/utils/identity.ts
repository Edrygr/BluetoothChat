import { v4 as uuidv4 } from 'uuid';

const ADJECTIVES = [
  'Swift','Dark','Bright','Silent','Rapid','Calm','Wild','Cool',
  'Bold','Sharp','Lazy','Brave','Quiet','Nimble','Foggy','Misty',
  'Steel','Iron','Neon','Amber','Cyan','Jade','Violet','Cobalt',
];

const NOUNS = [
  'Fox','Wolf','Hawk','Bear','Lynx','Raven','Tiger','Eagle',
  'Shark','Viper','Ghost','Storm','Pixel','Comet','Drifter','Echo',
  'Specter','Nomad','Glitch','Vector','Cipher','Nexus','Phantom','Rogue',
];

export function generateAnonymousId(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 99)
    .toString()
    .padStart(2, '0');
  return `${adj}${noun}${suffix}`;
}

export function generateMessageId(): string {
  return uuidv4();
}
