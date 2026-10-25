import sharp from "sharp";

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
const HASH_BITS = 64;

export async function differenceHash(input: Buffer | string | Uint8Array): Promise<string> {
  const { data, info } = await sharp(input)
    .grayscale()
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== HASH_WIDTH || info.height !== HASH_HEIGHT || info.channels !== 1) {
    throw new Error("Unable to normalize image for perceptual hashing");
  }

  let hash = 0n;
  let bit = 0n;
  for (let row = 0; row < HASH_HEIGHT; row += 1) {
    for (let column = 0; column < HASH_WIDTH - 1; column += 1) {
      const left = data[row * HASH_WIDTH + column];
      const right = data[row * HASH_WIDTH + column + 1];
      if (left === undefined || right === undefined) {
        throw new Error("Normalized image buffer is incomplete");
      }
      if (left > right) {
        hash |= 1n << bit;
      }
      bit += 1n;
    }
  }

  return hash.toString(16).padStart(HASH_BITS / 4, "0");
}

export function hashSimilarity(first: string, second: string): number {
  if (!/^[0-9a-f]{16}$/i.test(first) || !/^[0-9a-f]{16}$/i.test(second)) {
    throw new Error("Difference hashes must contain exactly 64 bits");
  }

  let difference = BigInt(`0x${first}`) ^ BigInt(`0x${second}`);
  let distance = 0;
  while (difference > 0n) {
    distance += Number(difference & 1n);
    difference >>= 1n;
  }
  return 1 - distance / HASH_BITS;
}
