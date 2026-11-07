// Shared by chapter downloads and the standalone converter to keep conversion memory bounded.
export class PdfQueue {
  constructor() { this.tail = Promise.resolve(); }
  run(operation) {
    const task = this.tail.then(operation);
    this.tail = task.catch(() => {});
    return task;
  }
}
