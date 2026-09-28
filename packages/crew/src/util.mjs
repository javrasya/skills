// Small helpers with no home of their own.

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// A label as a file name's part: word characters, dots and dashes, 60 at most.
export const slug = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)
