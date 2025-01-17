/*
* timing.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* A simple duration class that can be used to record and report
* durations at the millisecond level of resolution.
*/

import { ConsoleInterface } from './console';

export class Duration {
    private _startTime: number;

    constructor() {
        this._startTime = Date.now();
    }

    getDurationInMilliseconds() {
        const curTime = Date.now();
        return curTime - this._startTime;
    }

    getDurationInSeconds() {
        return this.getDurationInMilliseconds() / 1000;
    }
}

export class TimingStat {
    totalTime = 0;
    isTiming = false;

    timeOperation(callback: () => void) {
        // Handle reentrancy.
        if (this.isTiming) {
            callback();
        } else {
            this.isTiming = true;
            const duration = new Duration();
            callback();
            this.totalTime += duration.getDurationInMilliseconds();
            this.isTiming = false;
        }
    }

    subtractFromTime(callback: () => void) {
        if (this.isTiming) {
            this.isTiming = false;
            const duration = new Duration();
            callback();
            this.totalTime -= duration.getDurationInMilliseconds();
            this.isTiming = true;
        } else {
            callback();
        }
    }

    printTime(): string {
        const totalTimeInSec = this.totalTime / 1000;
        const roundedTime = Math.round(totalTimeInSec * 100) / 100;
        return roundedTime.toString() + 'sec';
    }
}

export class TimingStats {
    totalDuration = new Duration();
    findFilesTime = new TimingStat();
    readFileTime = new TimingStat();
    tokenizeFileTime = new TimingStat();
    parseFileTime = new TimingStat();
    resolveImportsTime = new TimingStat();
    cycleDetectionTime = new TimingStat();
    bindTime = new TimingStat();
    typeCheckerTime = new TimingStat();

    printSummary(console: ConsoleInterface) {
        console.log(`Completed in ${ this.totalDuration.getDurationInSeconds() }sec`);
    }

    printDetails(console: ConsoleInterface) {
        console.log('');
        console.log('Timing stats');
        console.log('Find Source Files:    ' + this.findFilesTime.printTime());
        console.log('Read Source Files:    ' + this.readFileTime.printTime());
        console.log('Tokenize:             ' + this.tokenizeFileTime.printTime());
        console.log('Parse:                ' + this.parseFileTime.printTime());
        console.log('Resolve Imports:      ' + this.resolveImportsTime.printTime());
        console.log('Bind:                 ' + this.bindTime.printTime());
        console.log('Check:                ' + this.typeCheckerTime.printTime());
        console.log('Detect Cycles:        ' + this.cycleDetectionTime.printTime());
    }
}

export let timingStats = new TimingStats();
