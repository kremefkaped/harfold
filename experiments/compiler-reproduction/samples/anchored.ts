/**
 */
export interface CachingDictionary {
}
class CachedDict implements CachingDictionary {
    constructor(
    ) {
    }
    #has = autoCache((word: string) => this.dict.has(word, this.options), DefaultAutoCacheSize);
    has = logRequests
        ? (word: string): boolean => {
              const value = this.#has(word);
          }
        : this.#has;
    readonly isNoSuggestWord = autoCache(
    );
    stats(): CallStats {
        return {
        };
    }
}
