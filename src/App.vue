<template>
  <Header title="云枝图床" desc="GitHub 存储 · jsDelivr 加速 · 图片永不过期" />
  <main><RouterView /></main>
  <Footer />
  <Toaster />
</template>
<script setup lang="ts">
import Header from '@/components/Header/Header.vue';
import Footer from '@/components/Footer/Footer.vue';
import { Toaster } from '@/components/ui/toast';
</script>

<style scoped></style>
