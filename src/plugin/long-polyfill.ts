import Long from 'long';
(globalThis as { Long?: typeof Long }).Long = Long;
