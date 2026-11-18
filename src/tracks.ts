// The music. Each track is the file music/<id>.m4a, and everything else refers to a track by its
// id, so a file can be swapped or a map pointed at another track by changing this one file.

export interface Track {
  id: string;
  title: string;
  artist: string;
  /** The credit lines the licence asks for (shown in Settings and listed in music/CREDITS.md). */
  credit: string[];
  /** Left out of the playlist until the player unlocks it. */
  secret?: boolean;
}

const SOURCE = 'https://freetouse.com/music';

export const TRACKS: Track[] = [
  { id: 'menu', title: 'Apache Flute', artist: 'Walen', credit: ['Music track: Apache Flute by Walen', `Source: ${SOURCE}`, 'Vlog Music for Videos (Free Download)'] },
  { id: 'nature', title: 'Sounds of Nature', artist: 'Aylex', credit: ['Music track: Sounds of Nature by Aylex', `Source: ${SOURCE}`, 'Free To Use Music for Video'] },
  { id: 'bread', title: 'Bread', artist: 'Lukrembo', credit: ['Music track: Bread by Lukrembo', `Source: ${SOURCE}`, 'Free Music Without Copyright (Safe)'] },
  { id: 'soaked', title: 'Soaked', artist: 'Pufino', credit: ['Music track: Soaked by Pufino', `Source: ${SOURCE}`, 'No Copyright Background Music'] },
  { id: 'space', title: 'Lurker', artist: 'Hazelwood', secret: true, credit: ['Music track: Lurker by Hazelwood', `Source: ${SOURCE}`, 'No Copyright Music for Videos (Free)'] },
];

/** Played on every menu screen. */
export const MENU_TRACK = 'menu';

/** The default on every space map; joins the playlist once the player beats a space map. */
export const SECRET_TRACK = 'space';

/** The track a map starts with. Adventure levels by level id, free maps by mode. */
export const MAP_TRACKS = {
  byLevel: {
    'first-landfall': 'nature',
    'a-patch-of-ground': 'bread',
    'the-lone-isle': 'nature',
    'x-marks-the-spot': 'bread',
    'still-waters': 'soaked',
    'a-guiding-star': 'bread',
    'thin-ice': 'soaked',
    'across-the-strait': 'soaked',
    'the-great-island': 'nature',
  } as Record<string, string>,
  byMode: { island: 'nature', endless: 'bread', daily: 'soaked' } as Record<string, string>,
};

export const trackById = (id: string) => TRACKS.find((t) => t.id === id);
