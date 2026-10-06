Component({
  options: { addGlobalClass: true },
  properties: {
    value: { type: Number, value: 1 },
    min: { type: Number, value: 1 },
    max: { type: Number, value: 4 }
  },
  methods: {
    onMinus() {
      const v = Number(this.data.value) - 1;
      if (v < this.data.min) return;
      this.triggerEvent('change', { value: v });
    },
    onPlus() {
      const v = Number(this.data.value) + 1;
      if (v > this.data.max) return;
      this.triggerEvent('change', { value: v });
    }
  }
});
