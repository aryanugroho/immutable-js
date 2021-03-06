/**
 *  Copyright (c) 2014-2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import {
  NOT_SET,
  ensureSize,
  wrapIndex,
  wholeSlice,
  resolveBegin,
  resolveEnd
} from './TrieUtils';
import {
  Iterable,
  KeyedIterable,
  SetIterable,
  IndexedIterable
} from './Iterable';
import {
  isIterable,
  isKeyed,
  isIndexed,
  isOrdered,
  IS_ORDERED_SENTINEL
} from './Predicates';
import {
  getIterator,
  Iterator,
  iteratorValue,
  iteratorDone,
  ITERATE_KEYS,
  ITERATE_VALUES,
  ITERATE_ENTRIES
} from './Iterator';
import {
  isSeq,
  Seq,
  KeyedSeq,
  SetSeq,
  IndexedSeq,
  keyedSeqFromValue,
  indexedSeqFromValue,
  ArraySeq
} from './Seq';

import { Map } from './Map';
import { OrderedMap } from './OrderedMap';

export class ToKeyedSequence extends KeyedSeq {
  constructor(indexed, useKeys) {
    this._iter = indexed;
    this._useKeys = useKeys;
    this.size = indexed.size;
  }

  get(key, notSetValue) {
    return this._iter.get(key, notSetValue);
  }

  has(key) {
    return this._iter.has(key);
  }

  valueSeq() {
    return this._iter.valueSeq();
  }

  reverse() {
    const reversedSequence = reverseFactory(this, true);
    if (!this._useKeys) {
      reversedSequence.valueSeq = () => this._iter.toSeq().reverse();
    }
    return reversedSequence;
  }

  map(mapper, context) {
    const mappedSequence = mapFactory(this, mapper, context);
    if (!this._useKeys) {
      mappedSequence.valueSeq = () => this._iter.toSeq().map(mapper, context);
    }
    return mappedSequence;
  }

  __iterate(fn, reverse) {
    return this._iter.__iterate((v, k) => fn(v, k, this), reverse);
  }

  __iterator(type, reverse) {
    return this._iter.__iterator(type, reverse);
  }
}
ToKeyedSequence.prototype[IS_ORDERED_SENTINEL] = true;

export class ToIndexedSequence extends IndexedSeq {
  constructor(iter) {
    this._iter = iter;
    this.size = iter.size;
  }

  includes(value) {
    return this._iter.includes(value);
  }

  __iterate(fn, reverse) {
    let i = 0;
    reverse && ensureSize(this);
    return this._iter.__iterate(
      v => fn(v, reverse ? this.size - ++i : i++, this),
      reverse
    );
  }

  __iterator(type, reverse) {
    const iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
    let i = 0;
    reverse && ensureSize(this);
    return new Iterator(() => {
      const step = iterator.next();
      return step.done
        ? step
        : iteratorValue(
            type,
            reverse ? this.size - ++i : i++,
            step.value,
            step
          );
    });
  }
}

export class ToSetSequence extends SetSeq {
  constructor(iter) {
    this._iter = iter;
    this.size = iter.size;
  }

  has(key) {
    return this._iter.includes(key);
  }

  __iterate(fn, reverse) {
    return this._iter.__iterate(v => fn(v, v, this), reverse);
  }

  __iterator(type, reverse) {
    const iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
    return new Iterator(() => {
      const step = iterator.next();
      return step.done
        ? step
        : iteratorValue(type, step.value, step.value, step);
    });
  }
}

export class FromEntriesSequence extends KeyedSeq {
  constructor(entries) {
    this._iter = entries;
    this.size = entries.size;
  }

  __iterate(fn, reverse) {
    return this._iter.__iterate(
      entry => {
        // Check if entry exists first so array access doesn't throw for holes
        // in the parent iteration.
        if (entry) {
          validateEntry(entry);
          const indexedIterable = isIterable(entry);
          return fn(
            indexedIterable ? entry.get(1) : entry[1],
            indexedIterable ? entry.get(0) : entry[0],
            this
          );
        }
      },
      reverse
    );
  }

  __iterator(type, reverse) {
    const iterator = this._iter.__iterator(ITERATE_VALUES, reverse);
    return new Iterator(() => {
      while (true) {
        const step = iterator.next();
        if (step.done) {
          return step;
        }
        const entry = step.value;
        // Check if entry exists first so array access doesn't throw for holes
        // in the parent iteration.
        if (entry) {
          validateEntry(entry);
          const indexedIterable = isIterable(entry);
          return iteratorValue(
            type,
            indexedIterable ? entry.get(0) : entry[0],
            indexedIterable ? entry.get(1) : entry[1],
            step
          );
        }
      }
    });
  }
}

ToIndexedSequence.prototype.cacheResult = (ToKeyedSequence.prototype.cacheResult = (ToSetSequence.prototype.cacheResult = (FromEntriesSequence.prototype.cacheResult = cacheResultThrough)));

export function flipFactory(iterable) {
  const flipSequence = makeSequence(iterable);
  flipSequence._iter = iterable;
  flipSequence.size = iterable.size;
  flipSequence.flip = () => iterable;
  flipSequence.reverse = function() {
    const reversedSequence = iterable.reverse.apply(this); // super.reverse()
    reversedSequence.flip = () => iterable.reverse();
    return reversedSequence;
  };
  flipSequence.has = key => iterable.includes(key);
  flipSequence.includes = key => iterable.has(key);
  flipSequence.cacheResult = cacheResultThrough;
  flipSequence.__iterateUncached = function(fn, reverse) {
    return iterable.__iterate((v, k) => fn(k, v, this) !== false, reverse);
  };
  flipSequence.__iteratorUncached = function(type, reverse) {
    if (type === ITERATE_ENTRIES) {
      const iterator = iterable.__iterator(type, reverse);
      return new Iterator(() => {
        const step = iterator.next();
        if (!step.done) {
          const k = step.value[0];
          step.value[0] = step.value[1];
          step.value[1] = k;
        }
        return step;
      });
    }
    return iterable.__iterator(
      type === ITERATE_VALUES ? ITERATE_KEYS : ITERATE_VALUES,
      reverse
    );
  };
  return flipSequence;
}

export function mapFactory(iterable, mapper, context) {
  const mappedSequence = makeSequence(iterable);
  mappedSequence.size = iterable.size;
  mappedSequence.has = key => iterable.has(key);
  mappedSequence.get = (key, notSetValue) => {
    const v = iterable.get(key, NOT_SET);
    return v === NOT_SET ? notSetValue : mapper.call(context, v, key, iterable);
  };
  mappedSequence.__iterateUncached = function(fn, reverse) {
    return iterable.__iterate(
      (v, k, c) => fn(mapper.call(context, v, k, c), k, this) !== false,
      reverse
    );
  };
  mappedSequence.__iteratorUncached = function(type, reverse) {
    const iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
    return new Iterator(() => {
      const step = iterator.next();
      if (step.done) {
        return step;
      }
      const entry = step.value;
      const key = entry[0];
      return iteratorValue(
        type,
        key,
        mapper.call(context, entry[1], key, iterable),
        step
      );
    });
  };
  return mappedSequence;
}

export function reverseFactory(iterable, useKeys) {
  const reversedSequence = makeSequence(iterable);
  reversedSequence._iter = iterable;
  reversedSequence.size = iterable.size;
  reversedSequence.reverse = () => iterable;
  if (iterable.flip) {
    reversedSequence.flip = function() {
      const flipSequence = flipFactory(iterable);
      flipSequence.reverse = () => iterable.flip();
      return flipSequence;
    };
  }
  reversedSequence.get = (key, notSetValue) =>
    iterable.get(useKeys ? key : -1 - key, notSetValue);
  reversedSequence.has = key => iterable.has(useKeys ? key : -1 - key);
  reversedSequence.includes = value => iterable.includes(value);
  reversedSequence.cacheResult = cacheResultThrough;
  reversedSequence.__iterate = function(fn, reverse) {
    let i = 0;
    reverse && ensureSize(iterable);
    return iterable.__iterate(
      (v, k) => fn(v, useKeys ? k : reverse ? this.size - ++i : i++, this),
      !reverse
    );
  };
  reversedSequence.__iterator = (type, reverse) => {
    let i = 0;
    reverse && ensureSize(iterable);
    const iterator = iterable.__iterator(ITERATE_ENTRIES, !reverse);
    return new Iterator(() => {
      const step = iterator.next();
      if (step.done) {
        return step;
      }
      const entry = step.value;
      return iteratorValue(
        type,
        useKeys ? entry[0] : reverse ? this.size - ++i : i++,
        entry[1],
        step
      );
    });
  };
  return reversedSequence;
}

export function filterFactory(iterable, predicate, context, useKeys) {
  const filterSequence = makeSequence(iterable);
  if (useKeys) {
    filterSequence.has = key => {
      const v = iterable.get(key, NOT_SET);
      return v !== NOT_SET && !!predicate.call(context, v, key, iterable);
    };
    filterSequence.get = (key, notSetValue) => {
      const v = iterable.get(key, NOT_SET);
      return v !== NOT_SET && predicate.call(context, v, key, iterable)
        ? v
        : notSetValue;
    };
  }
  filterSequence.__iterateUncached = function(fn, reverse) {
    let iterations = 0;
    iterable.__iterate(
      (v, k, c) => {
        if (predicate.call(context, v, k, c)) {
          return fn(v, useKeys ? k : iterations++, this);
        }
      },
      reverse
    );
    return iterations;
  };
  filterSequence.__iteratorUncached = function(type, reverse) {
    const iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
    let iterations = 0;
    return new Iterator(() => {
      while (true) {
        const step = iterator.next();
        if (step.done) {
          return step;
        }
        const entry = step.value;
        const key = entry[0];
        const value = entry[1];
        if (predicate.call(context, value, key, iterable)) {
          return iteratorValue(type, useKeys ? key : iterations++, value, step);
        }
      }
    });
  };
  return filterSequence;
}

export function countByFactory(iterable, grouper, context) {
  const groups = Map().asMutable();
  iterable.__iterate((v, k) => {
    groups.update(grouper.call(context, v, k, iterable), 0, a => a + 1);
  });
  return groups.asImmutable();
}

export function groupByFactory(iterable, grouper, context) {
  const isKeyedIter = isKeyed(iterable);
  const groups = (isOrdered(iterable) ? OrderedMap() : Map()).asMutable();
  iterable.__iterate((v, k) => {
    groups.update(
      grouper.call(context, v, k, iterable),
      a => ((a = a || []), a.push(isKeyedIter ? [k, v] : v), a)
    );
  });
  const coerce = iterableClass(iterable);
  return groups.map(arr => reify(iterable, coerce(arr)));
}

export function sliceFactory(iterable, begin, end, useKeys) {
  const originalSize = iterable.size;

  if (wholeSlice(begin, end, originalSize)) {
    return iterable;
  }

  const resolvedBegin = resolveBegin(begin, originalSize);
  const resolvedEnd = resolveEnd(end, originalSize);

  // begin or end will be NaN if they were provided as negative numbers and
  // this iterable's size is unknown. In that case, cache first so there is
  // a known size and these do not resolve to NaN.
  if (resolvedBegin !== resolvedBegin || resolvedEnd !== resolvedEnd) {
    return sliceFactory(iterable.toSeq().cacheResult(), begin, end, useKeys);
  }

  // Note: resolvedEnd is undefined when the original sequence's length is
  // unknown and this slice did not supply an end and should contain all
  // elements after resolvedBegin.
  // In that case, resolvedSize will be NaN and sliceSize will remain undefined.
  const resolvedSize = resolvedEnd - resolvedBegin;
  let sliceSize;
  if (resolvedSize === resolvedSize) {
    sliceSize = resolvedSize < 0 ? 0 : resolvedSize;
  }

  const sliceSeq = makeSequence(iterable);

  // If iterable.size is undefined, the size of the realized sliceSeq is
  // unknown at this point unless the number of items to slice is 0
  sliceSeq.size = sliceSize === 0
    ? sliceSize
    : (iterable.size && sliceSize) || undefined;

  if (!useKeys && isSeq(iterable) && sliceSize >= 0) {
    sliceSeq.get = function(index, notSetValue) {
      index = wrapIndex(this, index);
      return index >= 0 && index < sliceSize
        ? iterable.get(index + resolvedBegin, notSetValue)
        : notSetValue;
    };
  }

  sliceSeq.__iterateUncached = function(fn, reverse) {
    if (sliceSize === 0) {
      return 0;
    }
    if (reverse) {
      return this.cacheResult().__iterate(fn, reverse);
    }
    let skipped = 0;
    let isSkipping = true;
    let iterations = 0;
    iterable.__iterate((v, k) => {
      if (!(isSkipping && (isSkipping = skipped++ < resolvedBegin))) {
        iterations++;
        return fn(v, useKeys ? k : iterations - 1, this) !== false &&
          iterations !== sliceSize;
      }
    });
    return iterations;
  };

  sliceSeq.__iteratorUncached = function(type, reverse) {
    if (sliceSize !== 0 && reverse) {
      return this.cacheResult().__iterator(type, reverse);
    }
    // Don't bother instantiating parent iterator if taking 0.
    const iterator = sliceSize !== 0 && iterable.__iterator(type, reverse);
    let skipped = 0;
    let iterations = 0;
    return new Iterator(() => {
      while (skipped++ < resolvedBegin) {
        iterator.next();
      }
      if (++iterations > sliceSize) {
        return iteratorDone();
      }
      const step = iterator.next();
      if (useKeys || type === ITERATE_VALUES) {
        return step;
      }
      if (type === ITERATE_KEYS) {
        return iteratorValue(type, iterations - 1, undefined, step);
      }
      return iteratorValue(type, iterations - 1, step.value[1], step);
    });
  };

  return sliceSeq;
}

export function takeWhileFactory(iterable, predicate, context) {
  const takeSequence = makeSequence(iterable);
  takeSequence.__iterateUncached = function(fn, reverse) {
    if (reverse) {
      return this.cacheResult().__iterate(fn, reverse);
    }
    let iterations = 0;
    iterable.__iterate(
      (v, k, c) =>
        predicate.call(context, v, k, c) && ++iterations && fn(v, k, this)
    );
    return iterations;
  };
  takeSequence.__iteratorUncached = function(type, reverse) {
    if (reverse) {
      return this.cacheResult().__iterator(type, reverse);
    }
    const iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
    let iterating = true;
    return new Iterator(() => {
      if (!iterating) {
        return iteratorDone();
      }
      const step = iterator.next();
      if (step.done) {
        return step;
      }
      const entry = step.value;
      const k = entry[0];
      const v = entry[1];
      if (!predicate.call(context, v, k, this)) {
        iterating = false;
        return iteratorDone();
      }
      return type === ITERATE_ENTRIES ? step : iteratorValue(type, k, v, step);
    });
  };
  return takeSequence;
}

export function skipWhileFactory(iterable, predicate, context, useKeys) {
  const skipSequence = makeSequence(iterable);
  skipSequence.__iterateUncached = function(fn, reverse) {
    if (reverse) {
      return this.cacheResult().__iterate(fn, reverse);
    }
    let isSkipping = true;
    let iterations = 0;
    iterable.__iterate((v, k, c) => {
      if (!(isSkipping && (isSkipping = predicate.call(context, v, k, c)))) {
        iterations++;
        return fn(v, useKeys ? k : iterations - 1, this);
      }
    });
    return iterations;
  };
  skipSequence.__iteratorUncached = function(type, reverse) {
    if (reverse) {
      return this.cacheResult().__iterator(type, reverse);
    }
    const iterator = iterable.__iterator(ITERATE_ENTRIES, reverse);
    let skipping = true;
    let iterations = 0;
    return new Iterator(() => {
      let step;
      let k;
      let v;
      do {
        step = iterator.next();
        if (step.done) {
          if (useKeys || type === ITERATE_VALUES) {
            return step;
          }
          if (type === ITERATE_KEYS) {
            return iteratorValue(type, iterations++, undefined, step);
          }
          return iteratorValue(type, iterations++, step.value[1], step);
        }
        const entry = step.value;
        k = entry[0];
        v = entry[1];
        skipping && (skipping = predicate.call(context, v, k, this));
      } while (skipping);
      return type === ITERATE_ENTRIES ? step : iteratorValue(type, k, v, step);
    });
  };
  return skipSequence;
}

export function concatFactory(iterable, values) {
  const isKeyedIterable = isKeyed(iterable);
  const iters = [iterable]
    .concat(values)
    .map(v => {
      if (!isIterable(v)) {
        v = isKeyedIterable
          ? keyedSeqFromValue(v)
          : indexedSeqFromValue(Array.isArray(v) ? v : [v]);
      } else if (isKeyedIterable) {
        v = KeyedIterable(v);
      }
      return v;
    })
    .filter(v => v.size !== 0);

  if (iters.length === 0) {
    return iterable;
  }

  if (iters.length === 1) {
    const singleton = iters[0];
    if (
      singleton === iterable ||
      (isKeyedIterable && isKeyed(singleton)) ||
      (isIndexed(iterable) && isIndexed(singleton))
    ) {
      return singleton;
    }
  }

  let concatSeq = new ArraySeq(iters);
  if (isKeyedIterable) {
    concatSeq = concatSeq.toKeyedSeq();
  } else if (!isIndexed(iterable)) {
    concatSeq = concatSeq.toSetSeq();
  }
  concatSeq = concatSeq.flatten(true);
  concatSeq.size = iters.reduce(
    (sum, seq) => {
      if (sum !== undefined) {
        const size = seq.size;
        if (size !== undefined) {
          return sum + size;
        }
      }
    },
    0
  );
  return concatSeq;
}

export function flattenFactory(iterable, depth, useKeys) {
  const flatSequence = makeSequence(iterable);
  flatSequence.__iterateUncached = function(fn, reverse) {
    if (reverse) {
      return this.cacheResult().__iterate(fn, reverse);
    }
    let iterations = 0;
    let stopped = false;
    function flatDeep(iter, currentDepth) {
      iter.__iterate(
        (v, k) => {
          if ((!depth || currentDepth < depth) && isIterable(v)) {
            flatDeep(v, currentDepth + 1);
          } else if (
            fn(v, useKeys ? k : iterations++, flatSequence) === false
          ) {
            stopped = true;
          }
          return !stopped;
        },
        reverse
      );
    }
    flatDeep(iterable, 0);
    return iterations;
  };
  flatSequence.__iteratorUncached = function(type, reverse) {
    if (reverse) {
      return this.cacheResult().__iterator(type, reverse);
    }
    let iterator = iterable.__iterator(type, reverse);
    const stack = [];
    let iterations = 0;
    return new Iterator(() => {
      while (iterator) {
        const step = iterator.next();
        if (step.done !== false) {
          iterator = stack.pop();
          continue;
        }
        let v = step.value;
        if (type === ITERATE_ENTRIES) {
          v = v[1];
        }
        if ((!depth || stack.length < depth) && isIterable(v)) {
          stack.push(iterator);
          iterator = v.__iterator(type, reverse);
        } else {
          return useKeys ? step : iteratorValue(type, iterations++, v, step);
        }
      }
      return iteratorDone();
    });
  };
  return flatSequence;
}

export function flatMapFactory(iterable, mapper, context) {
  const coerce = iterableClass(iterable);
  return iterable
    .toSeq()
    .map((v, k) => coerce(mapper.call(context, v, k, iterable)))
    .flatten(true);
}

export function interposeFactory(iterable, separator) {
  const interposedSequence = makeSequence(iterable);
  interposedSequence.size = iterable.size && iterable.size * 2 - 1;
  interposedSequence.__iterateUncached = function(fn, reverse) {
    let iterations = 0;
    iterable.__iterate(
      v =>
        (!iterations || fn(separator, iterations++, this) !== false) &&
        fn(v, iterations++, this) !== false,
      reverse
    );
    return iterations;
  };
  interposedSequence.__iteratorUncached = function(type, reverse) {
    const iterator = iterable.__iterator(ITERATE_VALUES, reverse);
    let iterations = 0;
    let step;
    return new Iterator(() => {
      if (!step || iterations % 2) {
        step = iterator.next();
        if (step.done) {
          return step;
        }
      }
      return iterations % 2
        ? iteratorValue(type, iterations++, separator)
        : iteratorValue(type, iterations++, step.value, step);
    });
  };
  return interposedSequence;
}

export function sortFactory(iterable, comparator, mapper) {
  if (!comparator) {
    comparator = defaultComparator;
  }
  const isKeyedIterable = isKeyed(iterable);
  let index = 0;
  const entries = iterable
    .toSeq()
    .map((v, k) => [k, v, index++, mapper ? mapper(v, k, iterable) : v])
    .toArray();
  entries.sort((a, b) => comparator(a[3], b[3]) || a[2] - b[2]).forEach(
    isKeyedIterable
      ? (v, i) => {
          entries[i].length = 2;
        }
      : (v, i) => {
          entries[i] = v[1];
        }
  );
  return isKeyedIterable
    ? KeyedSeq(entries)
    : isIndexed(iterable) ? IndexedSeq(entries) : SetSeq(entries);
}

export function maxFactory(iterable, comparator, mapper) {
  if (!comparator) {
    comparator = defaultComparator;
  }
  if (mapper) {
    const entry = iterable
      .toSeq()
      .map((v, k) => [v, mapper(v, k, iterable)])
      .reduce((a, b) => maxCompare(comparator, a[1], b[1]) ? b : a);
    return entry && entry[0];
  }
  return iterable.reduce((a, b) => maxCompare(comparator, a, b) ? b : a);
}

function maxCompare(comparator, a, b) {
  const comp = comparator(b, a);
  // b is considered the new max if the comparator declares them equal, but
  // they are not equal and b is in fact a nullish value.
  return (comp === 0 &&
    b !== a &&
    (b === undefined || b === null || b !== b)) ||
    comp > 0;
}

export function zipWithFactory(keyIter, zipper, iters) {
  const zipSequence = makeSequence(keyIter);
  zipSequence.size = new ArraySeq(iters).map(i => i.size).min();
  // Note: this a generic base implementation of __iterate in terms of
  // __iterator which may be more generically useful in the future.
  zipSequence.__iterate = function(fn, reverse) {
    /* generic:
    var iterator = this.__iterator(ITERATE_ENTRIES, reverse);
    var step;
    var iterations = 0;
    while (!(step = iterator.next()).done) {
      iterations++;
      if (fn(step.value[1], step.value[0], this) === false) {
        break;
      }
    }
    return iterations;
    */
    // indexed:
    const iterator = this.__iterator(ITERATE_VALUES, reverse);
    let step;
    let iterations = 0;
    while (!(step = iterator.next()).done) {
      if (fn(step.value, iterations++, this) === false) {
        break;
      }
    }
    return iterations;
  };
  zipSequence.__iteratorUncached = function(type, reverse) {
    const iterators = iters.map(
      i => ((i = Iterable(i)), getIterator(reverse ? i.reverse() : i))
    );
    let iterations = 0;
    let isDone = false;
    return new Iterator(() => {
      let steps;
      if (!isDone) {
        steps = iterators.map(i => i.next());
        isDone = steps.some(s => s.done);
      }
      if (isDone) {
        return iteratorDone();
      }
      return iteratorValue(
        type,
        iterations++,
        zipper.apply(null, steps.map(s => s.value))
      );
    });
  };
  return zipSequence;
}

// #pragma Helper Functions

export function reify(iter, seq) {
  return iter === seq ? iter : isSeq(iter) ? seq : iter.constructor(seq);
}

function validateEntry(entry) {
  if (entry !== Object(entry)) {
    throw new TypeError('Expected [K, V] tuple: ' + entry);
  }
}

function iterableClass(iterable) {
  return isKeyed(iterable)
    ? KeyedIterable
    : isIndexed(iterable) ? IndexedIterable : SetIterable;
}

function makeSequence(iterable) {
  return Object.create(
    (isKeyed(iterable)
      ? KeyedSeq
      : isIndexed(iterable) ? IndexedSeq : SetSeq).prototype
  );
}

function cacheResultThrough() {
  if (this._iter.cacheResult) {
    this._iter.cacheResult();
    this.size = this._iter.size;
    return this;
  }
  return Seq.prototype.cacheResult.call(this);
}

function defaultComparator(a, b) {
  if (a === undefined && b === undefined) {
    return 0;
  }

  if (a === undefined) {
    return 1;
  }

  if (b === undefined) {
    return -1;
  }

  return a > b ? 1 : a < b ? -1 : 0;
}
