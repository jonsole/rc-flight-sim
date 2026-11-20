// Worker thread for ml/evaluate.js's Pool: scores one policy at a time.
import { parentPort, workerData } from 'node:worker_threads';
import { Evaluator } from './evaluate.js';

const ev = new Evaluator(workerData);
parentPort.on('message', ({ i, params, episodes }) => {
  parentPort.postMessage({ i, fitness: ev.score(params, episodes).fitness });
});
