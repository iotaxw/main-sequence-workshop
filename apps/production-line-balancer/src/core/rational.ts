const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('Denominator must be positive.');
  }
  if (numerator >= 0n) {
    return (numerator + denominator - 1n) / denominator;
  }
  return -((-numerator) / denominator);
}

export class Rational {
  static readonly zero = new Rational(0n, 1n);
  static readonly one = new Rational(1n, 1n);

  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  static of(numerator: bigint, denominator = 1n): Rational {
    if (denominator === 0n) {
      throw new Error('Denominator cannot be zero.');
    }
    if (numerator === 0n) {
      return Rational.zero;
    }
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator);
    return new Rational((numerator / divisor) * sign, (denominator / divisor) * sign);
  }

  static parse(value: string): Rational {
    const trimmed = value.trim();
    const rationalParts = trimmed.split('/');
    if (rationalParts.length === 2) {
      const [numerator, denominator] = rationalParts;
      if (!INTEGER_PATTERN.test(numerator ?? '') || !INTEGER_PATTERN.test(denominator ?? '')) {
        throw new Error(`Invalid rational value: ${value}.`);
      }
      return Rational.of(BigInt(numerator!), BigInt(denominator!));
    }
    if (rationalParts.length !== 1) {
      throw new Error(`Invalid rational value: ${value}.`);
    }
    if (INTEGER_PATTERN.test(trimmed)) {
      return Rational.of(BigInt(trimmed));
    }
    const match = DECIMAL_PATTERN.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid numeric value: ${value}.`);
    }
    const [, sign = '', significand = '', exponentText = '0'] = match;
    const exponent = Number(exponentText);
    if (!Number.isSafeInteger(exponent)) {
      throw new Error(`Exponent is too large: ${value}.`);
    }
    const [whole = '', fraction = ''] = significand.split('.');
    const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    const numerator = BigInt(`${sign === '-' ? '-' : ''}${digits}`);
    const scale = fraction.length - exponent;
    return scale >= 0
      ? Rational.of(numerator, 10n ** BigInt(scale))
      : Rational.of(numerator * 10n ** BigInt(-scale));
  }

  add(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  negate(): Rational {
    return Rational.of(-this.numerator, this.denominator);
  }

  subtract(other: Rational): Rational {
    return this.add(other.negate());
  }

  multiply(other: Rational): Rational {
    return Rational.of(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }

  divide(other: Rational): Rational {
    if (other.numerator === 0n) {
      throw new Error('Division by zero.');
    }
    return Rational.of(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    );
  }

  compare(other: Rational): number {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  ceil(): bigint {
    return ceilDiv(this.numerator, this.denominator);
  }

  toString(): string {
    return this.denominator === 1n
      ? this.numerator.toString()
      : `${this.numerator}/${this.denominator}`;
  }

  toDecimal(places = 2, mode: 'nearest' | 'ceiling' = 'nearest', trim = true): string {
    if (!Number.isInteger(places) || places < 0 || places > 18) {
      throw new Error('Decimal places must be an integer from 0 to 18.');
    }
    const scale = 10n ** BigInt(places);
    const scaledNumerator = this.numerator * scale;
    let units = ceilDiv(scaledNumerator, this.denominator);
    if (mode === 'nearest') {
      const negativeValue = scaledNumerator < 0n;
      const absoluteNumerator = negativeValue ? -scaledNumerator : scaledNumerator;
      let absoluteUnits = absoluteNumerator / this.denominator;
      if ((absoluteNumerator % this.denominator) * 2n >= this.denominator) {
        absoluteUnits++;
      }
      units = negativeValue ? -absoluteUnits : absoluteUnits;
    }
    const negative = units < 0n;
    const absolute = negative ? -units : units;
    const whole = absolute / scale;
    const fraction = (absolute % scale).toString().padStart(places, '0');
    const trimmedFraction = trim ? fraction.replace(/0+$/, '') : fraction;
    return `${negative ? '-' : ''}${whole}${trimmedFraction ? `.${trimmedFraction}` : ''}`;
  }

  toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }
}
