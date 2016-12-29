'use strict';

const config = require('config');
const leveldown = require(config.backend);
const log = require('npmlog');

leveldown.repair(config.queue, err => {
    if (err) {
        log.error('REPAIR', 'Database repair failed db="%s" error="%s"', config.queue, err.message);
    } else {
        log.info('REPAIR', 'Database repair completed');
    }
});
