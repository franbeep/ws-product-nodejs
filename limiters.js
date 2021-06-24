const RateLimiter = require('async-ratelimiter');
const Redis = require('ioredis');
const { getClientIp } = require('request-ip');
const moment = require('moment');

const maxTokens = 15;
const interval = 60 * 1000;

/**
 * Solution 1: Adapted solutioon from this guide: https://levelup.gitconnected.com/rate-limiting-your-serverless-applications-d718da5710d0
 * @param {Request} req Request Object
 * @param {Response} res Response Object
 * @param {NextFunction} next Next function in the pipeline
 */
const rateLimitHandlerV1 = async (req, res, next) => {
  // init redis server
  const redis = new Redis(
    `redis://redis:${process.env.REDISPASSWORD}@${process.env.REDISHOST}:${process.env.REDISPORT}/0`
  );
  redis.quit();

  // init rate limiter
  const rateLimiter = new RateLimiter({
    db: redis, // token storage
    max: maxTokens, // 3 tokens
    duration: interval, // per minute
  });

  // get ip and remaining tokens
  // if none remains, send 429 status code with message
  // otherwise go to the next function of the pipeline
  const clientIp = getClientIp(req) || 'Unknown IP';
  const tokens = await rateLimiter.get({ id: clientIp });
  if (tokens.remaining <= 0) {
    redis.quit();
    return res
      .status(429)
      .json({ message: 'You may only request 3 times per minute.' });
  }
  // set rate limiting headers
  res.set({
    'X-RateLimit-Limit': maxTokens,
    'X-RateLimit-Remaining': tokens.remaining - 1,
    'X-RateLimit-Reset': tokens.reset,
  });
  redis.quit();
  return next();
};

/**
 * Solution 2: Simple algorithm to throttle connection based on the number
 * of requests in specified interval of time
 * obs: needs restricting redis connections to 1 per IP
 *
 * @param {Request} req Request Object
 * @param {Response} res Response Object
 * @param {NextFunction} next Next function in the pipeline
 */
const rateLimitHandlerV2 = async (req, res, next) => {
  // init redis server
  const redis = new Redis(
    `redis://redis:${process.env.REDISPASSWORD}@${process.env.REDISHOST}:${process.env.REDISPORT}/0`
  );

  // get ip, and today's date, and remaining tokens (number)
  const clientIp = getClientIp(req) || 'Unknown IP';
  const today = moment();
  const remainingTokens =
    (await redis.get(`${clientIp}_remainingTokens__v2`)) || maxTokens;

  // if there was at least one token, decrement the number
  // and jump to the next function
  if (remainingTokens - 1 >= 0) {
    await redis.setnx(`${clientIp}_remainingTokens__v2`, remainingTokens);
    redis.decr(`${clientIp}_remainingTokens__v2`);
    redis.lpush(`${clientIp}_timestamps__v2`, today);
    // set rate limiting headers
    res.set({
      'X-RateLimit-Limit': maxTokens,
      'X-RateLimit-Remaining': 56,
      // 'X-RateLimit-Reset': Math.floor(today.format("X") + interval / 1000)
    });
    redis.quit();
    return next();
  }

  // no remaining tokens: trim the log of timestamps
  const timestamps = await redis.lrange(
    `${clientIp}_timestamps__v2`,
    0,
    maxTokens + 1
  );
  const filteredTimestamps = timestamps.filter(
    d => today.diff(moment(new Date(d)), 'milliseconds') < interval
  );

  // if after trimmed there are new tokens, update the array of timestamps,
  // and number of tokens available, and go to the next function
  if (maxTokens - filteredTimestamps.length - 1 >= 0) {
    await redis.ltrim(`${clientIp}_timestamps__v2`, -1, 0);
    redis.lpush(`${clientIp}_timestamps__v2`, [today, ...filteredTimestamps]);
    redis.set(
      `${clientIp}_remainingTokens__v2`,
      maxTokens - filteredTimestamps.length - 1
    );
    // set rate limiting headers
    res.set({
      'X-RateLimit-Limit': maxTokens,
      'X-RateLimit-Remaining': maxTokens - filteredTimestamps.length - 1,
      // 'X-RateLimit-Reset': Math.floor(
      //   moment(timestamps[0]).format('X') + interval / 1000
      // ),
    });
    redis.quit();
    return next();
  }

  // otherwise send status 429 with a message
  redis.quit();
  return res
    .status(429)
    .json({ message: 'You may only request 3 times per minute.' });
};

/**
 * Solution 3: Similar to solution 2, however instead of a list, it uses
 * a single timestamp from the first request sent to allocate the number
 * of requests in the subsequent interval of time. This could be considered
 * a greedy algorithm since it isn't calculating (and cannot) the number of
 * requests in the past interval of time.
 *
 * Example:
 * -o---------o--o---
 *
 * Assuming this is a timeline and the requests were at 0s, 50s, 59s and
 * you can only request 3 times each second, in the next second the amount
 * of tokens would be 1 (since in the last minute we still had those last
 * two), however it will reset to 3 tokens because it can only notice the
 * first request timestamp.
 * obs: needs restricting redis connections to 1 per IP
 *
 * @param {Request} req Request Object
 * @param {Response} res Response Object
 * @param {NextFunction} next Next function in the pipeline
 */
const rateLimitHandlerV3 = async (req, res, next) => {
  // init redis server
  const redis = new Redis(
    `redis://redis:${process.env.REDISPASSWORD}@${process.env.REDISHOST}:${process.env.REDISPORT}/0`
  );

  // get ip, and today's date, and remaining tokens (number)
  const clientIp = getClientIp(req) || 'Unknown IP';
  const today = moment();
  const remainingTokens =
    (await redis.get(`${clientIp}_remainingTokens__v3`)) || maxTokens;

  // if there was at least one token, decrement the number
  // and jump to the next function
  if (remainingTokens - 1 >= 0) {
    await redis.setnx(`${clientIp}_remainingTokens__v3`, remainingTokens);
    redis.decr(`${clientIp}_remainingTokens__v3`);
    redis.set(`${clientIp}_timestamp__v3`, today);
    // set rate limiting headers
    res.set({
      'X-RateLimit-Limit': maxTokens,
      'X-RateLimit-Remaining': remainingTokens - 1,
      // 'X-RateLimit-Reset': Math.floor(
      //   moment(await redis.get(`${clientIp}_timestamp`)).format('X') +
      //     interval / 1000
      // ),
    });
    redis.quit();
    return next();
  }

  // no remaining tokens: evaluate the last
  const timestamp = (await redis.get(`${clientIp}_timestamp__v3`)) || moment(0);

  // if it is old, reset tokens
  if (today.diff(moment(timestamp), 'milliseconds') > interval) {
    redis.set(`${clientIp}_remainingTokens__v3`, maxTokens - 1);
    redis.set(`${clientIp}_timestamp__v3`, today);
    // set rate limiting headers
    res.set({
      'X-RateLimit-Limit': maxTokens,
      'X-RateLimit-Remaining': maxTokens - 1,
      // 'X-RateLimit-Reset': Math.floor(today.format('X') + interval / 1000),
    });
    redis.quit();
    return next();
  }

  // otherwise send status 429 with a message
  redis.quit();
  return res
    .status(429)
    .json({ message: 'You may only request 3 times per minute.' });
};

/**
 * Obs:
 * Another solution would be using an authentication method, hashing server-side
 * the number of remaining tokens, and storing locally. With this method there
 * is no need for a redis server. The authentication would be partially for the
 * hash salt.
 */

module.exports = { rateLimitHandlerV1, rateLimitHandlerV2, rateLimitHandlerV3 };
