import { helperForB } from './a';

export function doSomethingInB() {
  console.log('Running B');
  const result = helperForB();
  console.log(result);
}
