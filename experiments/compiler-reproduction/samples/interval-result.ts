class CachedDict implements CachingDictionary {
    #has = autoCache((word: string) => this.dict.has(word, this.options), DefaultAutoCacheSize);
    has = logRequests
        ? (word: string): boolean => {
              const value = this.#has(word);
          }
        : this.#has;
}
