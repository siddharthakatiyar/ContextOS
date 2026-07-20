import { doSomethingInB } from './b';

export function doSomethingInA() {
  console.log('Running A');
  doSomethingInB();
}

export function helperForB() {
  return 'A helper result';
}
