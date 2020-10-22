"use strict";

const express = require('express');
const fs = require('fs');
const cors = require('cors');

const port = 5000;
const tempSensorId = "28-ee6b781a64ff";
const tempSensorFilePath = `/sys/bus/w1/devices/${tempSensorId}/w1_slave`;

const tempLogFilePath = "./temperatureLogFile.json";
const tempLoggingPeriodMs = 1000 * 60 * 10; // how long to wait between samplings of the temperature
const maxTempLogAgeMs = 1000 * 60 * 60 * 24 * 7; // throw out any logged temperature older than this

const globals = {
    furnaceState: {
        fan: false,
        heat: false,
        cool: false
    },
    tempLog: undefined
}

const app = express();
app.use(cors()); // allow all origins access


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


app.get('/log', (req, res) => {
    res.send(globals.tempLog);
});


app.get('/kill', (req, res) => {
    res.send("\nKILLING");
    process.kill(process.pid, 'SIGTERM');
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
        fs.writeFile(tempLogFilePath, stringTempLog, err => {
            if (err) { throw err; }
        });
    });
}


function startTempLogging(globals) {
    if (fs.existsSync(tempLogFilePath)) {
        const data = fs.readFileSync(tempLogFilePath);
        globals.tempLog = JSON.parse(data);
    } else {
        globals.tempLog = {};
    }

    logTemperature(); // run once before looping
    setInterval(logTemperature, tempLoggingPeriodMs);
}


function main() {
    startTempLogging(globals);
    app.listen(port, () => {
        console.log('server listening for connections');
    });
}

main();