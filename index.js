"use strict";

const express = require('express');
const fs = require('fs');
const cors = require('cors');
const onoff = require('onoff');

const port = 5000;
const tempSensorId = "28-ee6b781a64ff";
const tempSensorFilePath = `/sys/bus/w1/devices/${tempSensorId}/w1_slave`;

const tempScheduleFilePath = "./temperatureSchedule.json";
const furnaceUpdatePeriodMs = 1000 * 60 * 9; // minimum amount of time to wait between furnace updates

const tempLogFilePath = "./temperatureLogFile.json";
const tempLoggingPeriodMs = 1000 * 60 * 10; // how long to wait between samplings of the temperature
const maxTempLogAgeMs = 1000 * 60 * 60 * 24 * 7; // throw out any logged temperature older than this

const mainPowerPin = new onoff.Gpio(17, 'out');
const heatCoolSelectorPin = new onoff.Gpio(22, 'out');
const furnaceActions = {
    heat: "heat",
    cool: "cool",
    off: "off"
};

const globals = {
    furnaceState: {
        fan: false,
        heat: false,
        cool: false
    },
    tempLog: undefined,
    tempSchedule: undefined
};

const app = express();
app.use(cors()); // allow all origins access
app.use(express.json()); // to receive json post requests


function throwErrors(err) {
    if (err) {
        throw err;
    }
}


function isNumber(value) {
    return typeof(value) == "number" && (! isNaN(value));
}


function parseTempSensorData(data) {
    const crcSuccess = /crc=.. YES/.test(data);
    if (!crcSuccess) {
        return {error: "CRC failure"};
    }

    const tempMatch = data.match(/t=(\d+)/);
    if (tempMatch === null) {
        return {
            error: "couldn't find temperature in data", 
            data: data
        };
    } else if (tempMatch[1] == "0") { // assume a temp of 0 degrees is an error
        return {
            error: "read 0 degree temperature", 
            data: data
        };
    }

    return tempMatch[1] / 1000;
}


function getTemperature(callback) {
    fs.readFile(tempSensorFilePath, 'utf-8', (err, data) => {
        if (err) {
            callback(err);
        } else {
            callback(parseTempSensorData(data));
        }
    });
}


app.get('/state', (req, res) => {
    console.log("got request for state");
    getTemperature(temperature => {
        res.send({
            furnace: globals.furnaceState, 
            temperature: temperature
        });
        console.log("sent state");
    });
});


function performFurnaceAction(action) {
    switch (action) {
        case furnaceActions.heat:
            globals.furnaceState = {fan: true, heat: true, cool: false};
            mainPowerPin.write(0, throwErrors);
            heatCoolSelectorPin.write(1, throwErrors);
            break;
        case furnaceActions.cool:
            globals.furnaceState = {fan: true, heat: false, cool: true};
            mainPowerPin.write(0, throwErrors);
            heatCoolSelectorPin.write(0, throwErrors);
            break;
        case furnaceActions.off:
            globals.furnaceState = {fan: false, heat: false, cool: false};
            mainPowerPin.write(1, throwErrors);
            break;
    }
}

app.post('/state', (req, res) => {
    const action = req.body.action;
    if (action === undefined || furnaceActions[action] === undefined) {
        res.send({error: "invalid action"});
    } else {
        performFurnaceAction(action);
        res.send(globals.furnaceState);
    }
});


app.get('/log', (req, res) => {
    res.send(globals.tempLog);
});


app.get('/kill', (req, res) => {
    res.send("\nKILLING");
    process.kill(process.pid, 'SIGTERM');
});


app.post('/schedule', (req, res) => {
    let newTempTimeArray = undefined;
    try {
        newTempTimeArray = ObjToSortedTempTimeArray(req.body);
    } catch (error) {
        res.send(error);
    }

    if (newTempTimeArray !== undefined) {
        const tempTimeObjString = JSON.stringify(req.body);
        fs.writeFile(tempScheduleFilePath, tempTimeObjString, err => {
            if (err) {
                res.send(err);
            } else {
                globals.tempSchedule = newTempTimeArray;
                res.send('success');
            }
        });
    }
});



function logTemperature() {
    getTemperature(temperature => {
        const currentTime = Date.now();
        globals.tempLog[currentTime] = temperature;

        // remove old temperatures
        const oldestAllowedTime = currentTime - maxTempLogAgeMs;
        for (const time of Object.keys(globals.tempLog)) {
            if (time < oldestAllowedTime) {
                delete globals.tempLog[time];
            }
        }
        
        // save log file
        const stringTempLog = JSON.stringify(globals.tempLog);
        fs.writeFile(tempLogFilePath, stringTempLog, throwErrors);
    });
}


// represents a temperature at a specific time
function TempTime(timeStr, tempArray) {

    // times must be in format like 8:10 or 16:07
    const timeStrRegex = /^(\d{1,2}):(\d{2})$/;
    const extractedTimes = timeStr.match(timeStrRegex);
    if (extractedTimes === null) throw `Improperly formed time string: "${timeStr}"`;
    if (extractedTimes[1] < 0 || extractedTimes[1] > 23) throw `Invalid timeStr: ${timeStr} (invalid hour)`;
    if (extractedTimes[2] < 0 || extractedTimes[2] > 59) throw `Invalid timeStr: ${timeStr} (invalid minutes)`;

    // tempArray must be in format like [19, 21] where the 2nd number is max temp and first is min
    if (!Array.isArray(tempArray)) throw `temperature array must be an array, not: ${tempArray}`;
    if (tempArray.length != 2) throw `temperature array must have length 2, you have length ${tempArray.length}`;
    if ((!isNumber(tempArray[0])) || (!isNumber(tempArray[1]))) throw `Invalid temperature array: ${tempArray} (both values must be numbers)`;
    if (tempArray[0] >= tempArray[1]) throw `Invalid temperature array: ${tempArray} (min temperature must be less than max)`;

    this.hour = parseFloat(extractedTimes[1]);
    this.minutes = parseFloat(extractedTimes[2]);
    this.minTemp = tempArray[0];
    this.maxTemp = tempArray[1];
}


function compareTempTimes(tempTime1, tempTime2) {
    if (tempTime1.hour > tempTime2.hour) return 1;
    if (tempTime1.hour < tempTime2.hour) return -1;
    if (tempTime1.minutes > tempTime2.minutes) return 1;
    if (tempTime1.minutes < tempTime2.minutes) return -1;
    return 0;
}

function ObjToSortedTempTimeArray(obj) {
    let array = [];
    for (const [timeStr, tempArray] of Object.entries(obj)) {
        array.push(new TempTime(timeStr, tempArray));
    }
    array.sort(compareTempTimes);
    return array;
}


function updateFurnace() {
    if (globals.tempSchedule.length == 0) {
        console.log("no tempSchedule, skipping furnace update");
        return;
    }

    const currentTime = new Date();
    let correctTemp = globals.tempSchedule[globals.tempSchedule.length - 1]; // by default, the correct temperature is whatever temperature it should be at the end of the day
    globals.tempSchedule.forEach(tempTime => {
        const tempTimeIsBeforeCurrentTime = tempTime.hour < currentTime.getHours() || 
            (tempTime.hour == currentTime.getHours() && tempTime.minutes < currentTime.getMinutes());
        if (tempTimeIsBeforeCurrentTime) {
            correctTemp = tempTime;
        }
    });

    getTemperature(temperature => {
        if (isNumber(temperature)) {
            if (temperature < correctTemp.minTemp) {
                performFurnaceAction(furnaceActions.heat);
            } else if (temperature > correctTemp.maxTemp) {
                performFurnaceAction(furnaceActions.cool);
            } else {
                performFurnaceAction(furnaceActions.off);
            }
        } else {
            console.log("Tried to get temperature to update furnace but got error instead: ", temperature); // not using ${} because it formats objects wrong
        }
    });
}


function readJsonFileIfExists(path) {
    if (fs.existsSync(path)) {
        const data = fs.readFileSync(path);
        try {
            return JSON.parse(data);
        } catch (error) {
            console.log(`${path} does not contain valid json, defaulting to {}`);
            return {};
        }
    } else {
        return {};
    }
}


function startTempLogging(globals) {
    globals.tempLog = readJsonFileIfExists(tempLogFilePath);
    logTemperature(); // run once before looping
    setInterval(logTemperature, tempLoggingPeriodMs);
}


function startFurnaceUpdates(globals) {
    globals.tempSchedule = ObjToSortedTempTimeArray(readJsonFileIfExists(tempScheduleFilePath));
    updateFurnace(); // run once before looping
    setInterval(updateFurnace, furnaceUpdatePeriodMs);
}



function main() {
    performFurnaceAction(furnaceActions.off); // make sure furnace is initially off
    startTempLogging(globals);
    startFurnaceUpdates(globals);
    app.listen(port, () => {
        console.log('server listening for connections');
    });
}

main();